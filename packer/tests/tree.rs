mod common;

use std::ops::Range;

use common::{Json, fixture, hex, sha256};
use veritiles_pack::codec::Digest;
use veritiles_pack::plan::Leaves;
use veritiles_pack::proof::tree::{Entry, FileRef, Layout, Limits, plan};

fn leaf_digest(offset: u64) -> Digest {
    sha256(&offset.to_le_bytes())
}

fn bands_of(case: &Json) -> (Leaves, Vec<Range<u64>>) {
    let mut spans = Vec::new();
    let mut bands = Vec::new();
    for band in case.at("bands").arr() {
        let first = spans.len() as u64;
        spans.extend(band.arr().iter().map(|leaf| (leaf.arr()[0].u64(), leaf.arr()[1].u64())));
        bands.push(first..spans.len() as u64);
    }
    (Leaves::Spans(spans), bands)
}

fn limits_of(case: &Json) -> Limits {
    let defaults = Limits::default();
    let limit = |key, default| case.get(key).map_or(default, |v| v.u64() as usize);
    Limits {
        meta_max: limit("metaMaxEntries", defaults.meta_max),
        top_max: limit("topMaxEntries", defaults.top_max),
        sub_meta_max: limit("subMetaMaxEntries", defaults.sub_meta_max),
    }
}

// Every proof file in emission order, plus the top meta.
fn emit(layout: &Layout, leaves: &Leaves) -> (Vec<(String, Vec<u8>)>, Vec<u8>) {
    let shards: Vec<Vec<u8>> = layout
        .shards
        .iter()
        .map(|shard| {
            let digests: Vec<Digest> = shard.leaf_range().map(|i| leaf_digest(leaves.span(i).0)).collect();
            shard.encode(leaves, &digests)
        })
        .collect();
    let shard_digests: Vec<Digest> = shards.iter().map(|s| sha256(s)).collect();
    let (metas, top) = layout.seal(&shard_digests);
    let files = layout
        .files
        .iter()
        .map(|file| match *file {
            FileRef::Shard(i) => (layout.shards[i].path.clone(), shards[i].clone()),
            FileRef::Meta(i) => (layout.metas[i].path.clone(), metas[i].clone()),
        })
        .collect();
    (files, top)
}

#[test]
fn proof_tree_vectors() {
    for case in fixture("proof-tree.json").at("cases").arr() {
        let name = case.at("name").str();
        let (leaves, bands) = bands_of(case);
        let result = plan(&leaves, &bands, limits_of(case));
        if let Some(error) = case.get("error") {
            assert_eq!(result.unwrap_err().0, error.str(), "{name}");
            continue;
        }
        let layout = result.unwrap();
        let (files, top) = emit(&layout, &leaves);
        assert_eq!(hex(&top), case.at("topMeta").str(), "{name}: top meta");
        let want: Vec<(String, String)> = case
            .at("files")
            .arr()
            .iter()
            .map(|f| (f.at("path").str().to_string(), f.at("content").str().to_string()))
            .collect();
        let got: Vec<(String, String)> = files.into_iter().map(|(p, c)| (p, hex(&c))).collect();
        assert_eq!(got, want, "{name}: files");
    }
}

fn one_band(leaves: &Leaves) -> veritiles_pack::error::Result<Layout> {
    let band = 0..leaves.count();
    plan(leaves, std::slice::from_ref(&band), Limits::default())
}

fn spans_of(leaves: &Leaves) -> Leaves {
    Leaves::Spans((0..leaves.count()).map(|i| leaves.span(i)).collect())
}

fn shard_shape(layout: &Layout) -> Vec<(u64, u64, Range<u64>, String)> {
    layout.shards.iter().map(|s| (s.start, s.length, s.leaf_range(), s.path.clone())).collect()
}

#[test]
fn fixed_shards_match_the_per_leaf_rule() {
    let cases = [(1, 4000), (7, 20_000), (1 << 20, (1 << 20) * 3641 + 5), (3 << 30, 20 << 30), (1 << 31, 9 << 30)];
    for (chunk, size) in cases {
        let fixed = Leaves::Fixed { chunk, size };
        let spans = spans_of(&fixed);
        let a = one_band(&fixed).unwrap();
        let b = one_band(&spans).unwrap();
        assert_eq!(shard_shape(&a), shard_shape(&b), "chunk {chunk} size {size}");
    }
}

#[test]
fn fixed_leaves_cover_the_input() {
    let leaves = Leaves::Fixed { chunk: 10, size: 25 };
    assert_eq!(leaves.count(), 3);
    assert_eq!(leaves.span(2), (20, 5));
    assert_eq!(Leaves::Fixed { chunk: 10, size: 20 }.count(), 2);
}

#[test]
fn empty_input_is_one_empty_leaf_and_fails() {
    let leaves = Leaves::Fixed { chunk: 10, size: 0 };
    assert_eq!(leaves.count(), 1);
    let err = one_band(&leaves).unwrap_err();
    assert_eq!(err.0, "invalid record length 0");
}

#[test]
fn top_meta_limit_fails_before_hashing() {
    // 1 KiB chunks on 1 TiB: 589,969 shards, so the band splits into 1,479
    // directories, the first 1,327 of 399 shards and the rest of 398, and the
    // layout fits; a lone band never overflows the top meta.
    let leaves = Leaves::Fixed { chunk: 1024, size: 1 << 40 };
    let layout = one_band(&leaves).unwrap();
    assert_eq!(layout.top.len(), 1479);
    assert!(layout.top.iter().all(|entry| matches!(entry, Entry::Dir(_))));
    let sizes: Vec<usize> = layout.metas.iter().map(|meta| meta.entries.len()).collect();
    assert_eq!(sizes, [vec![399; 1327], vec![398; 152]].concat());
    let many: Vec<Range<u64>> = (0..1599).map(|i| i..i + 1).collect();
    let spans = Leaves::Spans((0..1599).map(|i| (i, 1)).collect());
    let err = plan(&spans, &many, Limits::default()).unwrap_err();
    assert_eq!(err.0, "top meta needs 1599 entries, over the 1598 limit");
}

#[test]
fn inlining_leaves_a_top_slot_for_each_later_band() {
    // Leaves 2^33 bytes apart: one shard each.
    let spans = Leaves::Spans((0..1599).map(|i| (i << 33, 1)).collect());
    let kinds = |layout: &Layout| layout.top.iter().map(|e| matches!(e, Entry::Dir(_))).collect::<Vec<_>>();
    // [1598, 1]: the first band leaves one slot, so it splits into five
    // directories.
    let bands = [0..1598, 1598..1598, 1598..1599];
    let layout = plan(&spans, &bands, Limits::default()).unwrap();
    assert_eq!(kinds(&layout), [true, true, true, true, true, false]);
    // [1597, 1]: both fit inline.
    let bands = [0..1597, 1597..1598];
    let layout = plan(&spans, &bands, Limits::default()).unwrap();
    assert_eq!(layout.top.len(), 1598);
    assert!(kinds(&layout).iter().all(|dir| !dir));
}
