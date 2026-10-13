// The pack pass (scan.rs): leaves are hashed in steps beside the whole-file
// hasher, and shard files are written as they complete. With --unixfs, the
// same steps also hash the input's 256 KiB UnixFS chunks and hand their
// digests, in order, to a chunk sink.
use std::ops::Range;

use rayon::prelude::*;
use sha2::{Digest as _, Sha256};

use crate::codec::Digest;
use crate::error::{Result, io_error};
use crate::input::Input;
use crate::pack::output_path;
use crate::plan::Leaves;
use crate::proof::tree::Layout;
use crate::scan::{Scan, min_task_len, step_end, with_file_digest};
use crate::unixfs::CHUNK;

const STEP_LEAVES: u64 = 1 << 20;

pub struct Hashed {
    pub map_digest: Digest,
    pub shard_digests: Vec<Digest>,
}

/// Receives UnixFS chunk digests in file order, a step at a time.
pub type ChunkSink<'a> = dyn FnMut(Vec<Digest>) -> Result<()> + 'a;

pub fn hash_and_write_shards(
    input: &Input,
    leaves: &Leaves,
    layout: &Layout,
    out: &str,
    chunks: Option<&mut ChunkSink>,
) -> Result<Hashed> {
    let walk = |scan: &Scan| walk_leaves(scan, input.bytes(), leaves, layout, out, chunks);
    let (shard_digests, map_digest) = with_file_digest(input, walk)?;
    Ok(Hashed { map_digest, shard_digests })
}

fn walk_leaves(
    scan: &Scan,
    bytes: &[u8],
    leaves: &Leaves,
    layout: &Layout,
    out: &str,
    mut chunks: Option<&mut ChunkSink>,
) -> Result<Vec<Digest>> {
    let mut assembler = Assembler::new(layout, leaves);
    let (mut first, mut next_chunk) = (0, 0);
    while first < leaves.count() {
        let last = step_end(first, leaves.count(), STEP_LEAVES, |i| leaves.span(i).0);
        let (offset, length) = leaves.span(last - 1);
        scan.begin_step(offset + length);
        let chunk_end = if chunks.is_some() { chunks_before(offset + length, bytes.len() as u64) } else { 0 };
        let (digests, chunk_digests) =
            rayon::join(|| hash_leaves(bytes, leaves, first..last), || hash_chunks(bytes, next_chunk..chunk_end));
        if let Some(sink) = chunks.as_mut().filter(|_| chunk_end > next_chunk) {
            sink(chunk_digests)?;
            next_chunk = chunk_end;
        }
        let done = assembler.add(first, &digests);
        let written: Vec<(usize, Digest)> =
            done.par_iter().map(|(i, file)| write_shard(layout, out, *i, file)).collect::<Result<_>>()?;
        written.into_iter().for_each(|(i, digest)| assembler.set_digest(i, digest));
        first = last;
    }
    Ok(assembler.shard_digests)
}

fn hash_leaves(bytes: &[u8], leaves: &Leaves, range: Range<u64>) -> Vec<Digest> {
    let (last_offset, last_length) = leaves.span(range.end - 1);
    let span = last_offset + last_length - leaves.span(range.start).0;
    let count = (range.end - range.start) as usize;
    let hash = |i: u64| {
        let (offset, length) = leaves.span(i);
        Sha256::digest(&bytes[offset as usize..(offset + length) as usize]).into()
    };
    (0..count).into_par_iter().with_min_len(min_task_len(span, count)).map(|k| hash(range.start + k as u64)).collect()
}

// The UnixFS chunks that end at or before `end`: all of them at the end of
// the file, where the last chunk may be short.
fn chunks_before(end: u64, size: u64) -> u64 {
    if end == size {
        return size.div_ceil(CHUNK as u64);
    }
    end / CHUNK as u64
}

fn hash_chunks(bytes: &[u8], range: Range<u64>) -> Vec<Digest> {
    let hash = |i: u64| {
        let start = i as usize * CHUNK;
        Sha256::digest(&bytes[start..(start + CHUNK).min(bytes.len())]).into()
    };
    range.into_par_iter().map(hash).collect()
}

fn write_shard(layout: &Layout, out: &str, index: usize, file: &[u8]) -> Result<(usize, Digest)> {
    let path = output_path(out, &layout.shards[index].path);
    std::fs::write(&path, file).map_err(|e| io_error(&e, "open", &path))?;
    Ok((index, Sha256::digest(file).into()))
}

// Collects leaf digests, arriving in file order, into complete shard files.
struct Assembler<'a> {
    layout: &'a Layout,
    leaves: &'a Leaves,
    shard: usize,
    digests: Vec<Digest>,
    shard_digests: Vec<Digest>,
}

impl<'a> Assembler<'a> {
    fn new(layout: &'a Layout, leaves: &'a Leaves) -> Self {
        let shard_digests = vec![[0; 32]; layout.shards.len()];
        Assembler { layout, leaves, shard: 0, digests: Vec::new(), shard_digests }
    }

    // Leaf digests for leaves `first..`; returns the shard files they complete.
    fn add(&mut self, first: u64, digests: &[Digest]) -> Vec<(usize, Vec<u8>)> {
        let mut done = Vec::new();
        for (leaf, digest) in (first..).zip(digests) {
            self.digests.push(*digest);
            let shard = &self.layout.shards[self.shard];
            if leaf + 1 == shard.leaf_range().end {
                done.push((self.shard, shard.encode(self.leaves, &self.digests)));
                self.digests.clear();
                self.shard += 1;
            }
        }
        done
    }

    fn set_digest(&mut self, shard: usize, digest: Digest) {
        self.shard_digests[shard] = digest;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_take_whole_chunks_until_the_end() {
        let chunk = CHUNK as u64;
        assert_eq!(chunks_before(3 * chunk - 1, 10 * chunk), 2);
        assert_eq!(chunks_before(3 * chunk, 10 * chunk), 3);
        assert_eq!(chunks_before(3 * chunk + 1, 3 * chunk + 1), 4);
    }
}
