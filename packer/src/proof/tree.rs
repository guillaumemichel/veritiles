// Proof-tree layout (tools/pack.ts buildProofTree): bands → shards → metas.
// The shape depends only on leaf spans, so it is planned — and its errors
// raised — before any byte is hashed; `seal` fills in digests afterwards.
use std::ops::Range;

use sha2::{Digest as _, Sha256};

use crate::codec::Digest;
use crate::error::Result;
use crate::plan::Leaves;
use crate::proof::format::{
    KIND_DIR, KIND_SHARD, MAX_SHARD_RECORDS, META_FILE_CAP, META_RECORD_SIZE, SHARD_RECORD_SIZE, push_meta_record,
    push_shard_record, shard_name,
};

// The top meta is a descriptor byte string whose DRISL head carries at most a
// 2-byte length.
const TOP_META_CAP: usize = 0xffff;
/// A band too large for the top meta splits into directories of at most this
/// many shards: 399 records fit in 16 KiB, so the first view into the band
/// waits on a small meta, while the top meta grows by only a few entries.
pub const SUB_META_MAX_ENTRIES: usize = 399;
const MAX_REL_OFFSET: u64 = u32::MAX as u64;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub meta_max: usize,
    pub top_max: usize,
    /// Shards per directory of a split band; `meta_max` caps it.
    pub sub_meta_max: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            meta_max: META_FILE_CAP / META_RECORD_SIZE,
            top_max: TOP_META_CAP / META_RECORD_SIZE,
            sub_meta_max: SUB_META_MAX_ENTRIES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Shard {
    pub start: u64,
    pub length: u64,
    pub first_leaf: u64,
    pub leaf_count: u64,
    /// Proof-base-relative file path.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    Shard(usize),
    Dir(usize),
}

#[derive(Debug, Clone)]
pub struct Meta {
    /// Proof-base-relative path, ending in `/meta`.
    pub path: String,
    pub entries: Vec<Entry>,
    pub length: u64,
}

/// A proof file, in the order tools/pack.ts emits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRef {
    Shard(usize),
    Meta(usize),
}

#[derive(Debug, Default)]
pub struct Layout {
    pub shards: Vec<Shard>,
    /// Post-order: every subdirectory's meta precedes its parent's.
    pub metas: Vec<Meta>,
    pub top: Vec<Entry>,
    pub files: Vec<FileRef>,
}

impl Shard {
    pub fn leaf_range(&self) -> Range<u64> {
        self.first_leaf..self.first_leaf + self.leaf_count
    }

    /// The shard file: one record per leaf, `digests` in leaf order.
    pub fn encode(&self, leaves: &Leaves, digests: &[Digest]) -> Vec<u8> {
        let mut out = Vec::with_capacity(digests.len() * SHARD_RECORD_SIZE);
        for (leaf, digest) in self.leaf_range().zip(digests) {
            let relative = leaves.span(leaf).0 - self.start;
            push_shard_record(&mut out, relative as u32, digest);
        }
        out
    }
}

pub fn plan(leaves: &Leaves, bands: &[Range<u64>], limits: Limits) -> Result<Layout> {
    let mut layout = Layout::default();
    let bands: Vec<&Range<u64>> = bands.iter().filter(|band| !band.is_empty()).collect();
    for (k, band) in bands.iter().enumerate() {
        let first = layout.shards.len();
        layout.shards.extend(shard_groups(leaves, (*band).clone()));
        layout.add_band(first..layout.shards.len(), bands.len() - k - 1, limits);
    }
    if layout.top.len() > limits.top_max {
        let message = format!("top meta needs {} entries, over the {} limit", layout.top.len(), limits.top_max);
        return Err(message.into());
    }
    if layout.shards.iter().any(|shard| shard.length == 0) {
        return Err("invalid record length 0".into());
    }
    Ok(layout)
}

impl Layout {
    // A band goes into the top meta only while the running total fits with
    // one slot left for each band after it (each needs at least one). A small
    // band lists its shards there; a larger one splits into directories of
    // at most `sub_meta_max` shards, each listed there, or, when those do not
    // fit either, becomes one directory with its own meta tree.
    fn add_band(&mut self, band: Range<usize>, bands_after: usize, limits: Limits) {
        let count = band.len();
        if count <= limits.meta_max && self.top.len() + count + bands_after <= limits.top_max {
            for i in band {
                self.shards[i].path = shard_name(self.shards[i].start);
                self.files.push(FileRef::Shard(i));
                self.top.push(Entry::Shard(i));
            }
            return;
        }
        let dirs = count.div_ceil(limits.sub_meta_max.min(limits.meta_max));
        let split = self.top.len() + dirs + bands_after <= limits.top_max;
        for shards in split_evenly(band, if split { dirs } else { 1 }) {
            let dir = format!("{}/", shard_name(self.shards[shards.start].start));
            let meta = self.emit_dir(shards, &dir, limits.meta_max);
            self.top.push(Entry::Dir(meta));
        }
    }

    // Left-shallow nesting: the earliest shards stay at this level, the tail
    // nests into subdirectories. Returns the directory's meta index.
    fn emit_dir(&mut self, shards: Range<usize>, dir: &str, max: usize) -> usize {
        let mut head = shards.clone();
        let mut entries = Vec::new();
        if shards.len() > max {
            head = shards.start..shards.start + max / 2;
            let rest = head.end..shards.end;
            let group_size = rest.len().div_ceil(max - max / 2);
            for lo in rest.clone().step_by(group_size) {
                let group = lo..(lo + group_size).min(rest.end);
                let sub = format!("{dir}{}/", shard_name(self.shards[lo].start));
                entries.push(Entry::Dir(self.emit_dir(group, &sub, max)));
            }
        }
        for i in head.clone() {
            self.shards[i].path = format!("{dir}{}", shard_name(self.shards[i].start));
            self.files.push(FileRef::Shard(i));
        }
        entries.splice(0..0, head.map(Entry::Shard));
        let length = entries.iter().map(|&entry| self.entry_length(entry)).sum();
        self.metas.push(Meta { path: format!("{dir}meta"), entries, length });
        self.files.push(FileRef::Meta(self.metas.len() - 1));
        self.metas.len() - 1
    }

    fn entry_length(&self, entry: Entry) -> u64 {
        match entry {
            Entry::Shard(i) => self.shards[i].length,
            Entry::Dir(i) => self.metas[i].length,
        }
    }

    /// Meta file contents (indexed like `metas`) and the top meta, from the
    /// shard files' digests.
    pub fn seal(&self, shard_digests: &[Digest]) -> (Vec<Vec<u8>>, Vec<u8>) {
        let mut metas: Vec<Vec<u8>> = Vec::with_capacity(self.metas.len());
        let mut meta_digests: Vec<Digest> = Vec::with_capacity(self.metas.len());
        for meta in &self.metas {
            let bytes = self.encode_meta(&meta.entries, shard_digests, &meta_digests);
            meta_digests.push(Sha256::digest(&bytes).into());
            metas.push(bytes);
        }
        let top = self.encode_meta(&self.top, shard_digests, &meta_digests);
        (metas, top)
    }

    fn encode_meta(&self, entries: &[Entry], shard_digests: &[Digest], meta_digests: &[Digest]) -> Vec<u8> {
        let mut out = Vec::with_capacity(entries.len() * META_RECORD_SIZE);
        for &entry in entries {
            let (kind, digest) = match entry {
                Entry::Shard(i) => (KIND_SHARD, &shard_digests[i]),
                Entry::Dir(i) => (KIND_DIR, &meta_digests[i]),
            };
            push_meta_record(&mut out, kind, self.entry_length(entry), digest);
        }
        out
    }
}

// `range` cut into `parts` consecutive runs whose lengths differ by at most
// one: with q = len / parts and r = len % parts, the first r runs hold q + 1
// items and the others q.
fn split_evenly(range: Range<usize>, parts: usize) -> impl Iterator<Item = Range<usize>> {
    let (size, extra) = (range.len() / parts, range.len() % parts);
    (0..parts).scan(range.start, move |start, i| {
        let end = *start + size + usize::from(i < extra);
        Some(std::mem::replace(start, end)..end)
    })
}

/// The shards a band of leaves fills, as `plan` groups them.
pub fn shard_count(leaves: &Leaves, band: Range<u64>) -> usize {
    shard_groups(leaves, band).len()
}

// A shard closes at the record cap, or early when the next leaf's offset
// relative to the shard start would not fit u32.
fn shard_groups(leaves: &Leaves, band: Range<u64>) -> Vec<Shard> {
    if let Leaves::Fixed { chunk, size } = *leaves {
        return fixed_shard_groups(chunk, size, band);
    }
    let mut shards = Vec::new();
    let mut first = band.start;
    for i in band.start + 1..=band.end {
        let fits = i < band.end
            && i - first < MAX_SHARD_RECORDS as u64
            && leaves.span(i).0 - leaves.span(first).0 <= MAX_REL_OFFSET;
        if fits {
            continue;
        }
        let length = (first..i).map(|leaf| leaves.span(leaf).1).sum();
        shards.push(new_shard(leaves.span(first).0, length, first..i));
        first = i;
    }
    shards
}

// Uniform leaves give uniform shards, so the grouping is arithmetic — no
// per-leaf loop even for billions of 1-byte leaves.
fn fixed_shard_groups(chunk: u64, size: u64, band: Range<u64>) -> Vec<Shard> {
    let per_shard = (MAX_SHARD_RECORDS as u64).min(MAX_REL_OFFSET / chunk + 1);
    let shard = |first: u64| {
        let last = (first + per_shard).min(band.end);
        let start = first * chunk;
        new_shard(start, last.saturating_mul(chunk).min(size) - start, first..last)
    };
    band.clone().step_by(per_shard as usize).map(shard).collect()
}

fn new_shard(start: u64, length: u64, leaves: Range<u64>) -> Shard {
    Shard { start, length, first_leaf: leaves.start, leaf_count: leaves.end - leaves.start, path: String::new() }
}
