// PMTiles parsing end to end: leaf directories, batching, the TS error
// order, and the default tile group. Byte-for-byte agreement with
// tools/pack.ts over a wider corpus is test/pack-diff.test.ts.
mod common;

use std::io::Write;

use common::run::Dir;
use common::{fixture, hex, sha256, unhex};
use flate2::Compression;
use flate2::write::GzEncoder;
use veritiles_pack::codec::varint::push_varint;
use veritiles_pack::pack::choose_tile_group;
use veritiles_pack::plan::cuts::{bands, leaf_spans};
use veritiles_pack::plan::pmtiles::decompress::{GZIP, NONE};
use veritiles_pack::plan::pmtiles::ranges::Groups;
use veritiles_pack::plan::pmtiles::{Parsed, parse, parse_with_max_entries};
use veritiles_pack::proof::tree::Limits;

/// Entries `(tile_id, run_length, length, stored_offset)`.
fn directory(entries: &[(u64, u64, u64, u64)]) -> Vec<u8> {
    let mut out = Vec::new();
    push_varint(&mut out, entries.len() as u64);
    let mut last = 0;
    for &(id, ..) in entries {
        push_varint(&mut out, id - last);
        last = id;
    }
    for column in [1, 2, 3] {
        for entry in entries {
            push_varint(&mut out, [entry.0, entry.1, entry.2, entry.3][column]);
        }
    }
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn stored(bytes: &[u8], compression: u8) -> Vec<u8> {
    if compression == GZIP { gzip(bytes) } else { bytes.to_vec() }
}

/// Header, root, metadata `{}`, leaf section, then `tiles` bytes of tile data.
fn archive(root: &[u8], leaves: &[u8], tiles: usize, compression: u8) -> Vec<u8> {
    let metadata = stored(b"{}", compression);
    let root = stored(root, compression);
    let sections = [(127, root.len()), (127 + root.len(), metadata.len())];
    let leaf_offset = sections[1].0 + metadata.len();
    let tile_offset = leaf_offset + leaves.len();
    let fields = [sections[0], sections[1], (leaf_offset, leaves.len()), (tile_offset, tiles)];
    let mut bytes = b"PMTiles\x03".to_vec();
    for (offset, length) in fields {
        bytes.extend((offset as u64).to_le_bytes());
        bytes.extend((length as u64).to_le_bytes());
    }
    bytes.resize(127, 0);
    bytes[97] = compression;
    bytes.extend([root, metadata, leaves.to_vec()].concat());
    bytes.extend((0..tiles).map(|i| (i * 31 % 251) as u8));
    bytes
}

fn error(bytes: &[u8]) -> String {
    parse(bytes).err().expect("parse should fail").0
}

fn ranges(parsed: &Parsed) -> Vec<(u64, u32, u32)> {
    parsed.tiles.records.iter().map(|r| (r.offset, r.length, r.seq)).collect()
}

#[test]
fn leaf_directories_decode_once_each_in_root_order() {
    let leaf_a = gzip(&directory(&[(0, 1, 100, 101), (1, 1, 100, 1)]));
    let leaf_b = gzip(&directory(&[(2, 1, 100, 201)]));
    let (a, b) = (leaf_a.len() as u64, leaf_b.len() as u64);
    let root = directory(&[(0, 0, a, 1), (2, 0, b, a + 1), (3, 0, a, 1), (4, 1, 50, 251)]);
    let bytes = archive(&root, &[leaf_a, leaf_b].concat(), 300, GZIP);
    let parsed = parse(&bytes).unwrap();
    let tile_data = parsed.tile_data.start;
    let expected =
        [(tile_data, 100, 1), (tile_data + 100, 100, 0), (tile_data + 200, 100, 2), (tile_data + 250, 50, 3)];
    assert_eq!(ranges(&parsed), expected);
    assert_eq!(parsed.tiles.zooms, [0, 1, 1, 1]);
    assert!(parsed.boundaries.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(parsed.boundaries.last(), Some(&(bytes.len() as u64)));
}

#[test]
fn many_leaf_directories_span_several_batches() {
    let leaves: Vec<Vec<u8>> = (0..2500).map(|i| directory(&[(i, 1, 1, i + 1)])).collect();
    let starts: Vec<usize> = leaves.iter().scan(0, |at, leaf| Some(std::mem::replace(at, *at + leaf.len()))).collect();
    let pointer = |i: usize| (2500 - i as u64, 0, leaves[i].len() as u64, starts[i] as u64 + 1);
    let root: Vec<_> = (0..2500).rev().map(pointer).collect();
    let bytes = archive(&directory(&root), &leaves.concat(), 2500, NONE);
    let parsed = parse(&bytes).unwrap();
    assert_eq!(parsed.tiles.records.len(), 2500);
    // Root order is reversed, so the tile at offset 0 is the last entry seen.
    assert_eq!(parsed.tiles.records[0].seq, 2499);
    let groups = Groups::new(&parsed.tiles, 1 << 20);
    let spans = leaf_spans(bytes.len() as u64, &parsed.boundaries, &groups);
    assert_eq!(spans.iter().map(|s| s.1).sum::<u64>(), bytes.len() as u64);
    assert!(bands(&spans, parsed.tile_data.clone(), &groups).is_ok());
}

#[test]
fn directory_errors_come_first_in_root_order() {
    let empty = directory(&[]);
    let good = directory(&[(0, 1, 10, 1)]);
    let n = empty.len() as u64;
    // An empty leaf, then a pointer outside the archive: the leaf fails first.
    let root = directory(&[(0, 0, n, 1), (1, 0, 5000, 1)]);
    assert_eq!(error(&archive(&root, &empty, 10, NONE)), "Empty directory is invalid");
    // A failing tile, then a leaf that fails to decode: the leaf error wins.
    let root = directory(&[(0, 1, 11, 1), (1, 0, n, 1)]);
    assert_eq!(error(&archive(&root, &empty, 10, NONE)), "Empty directory is invalid");
    // A failing tile, then a good leaf: the tile error stands.
    let root = directory(&[(0, 1, 11, 1), (1, 0, good.len() as u64, 1)]);
    assert_eq!(error(&archive(&root, &good, 10, NONE)), "PMTiles tile lies outside tile data");
    // A nested leaf pointer inside a leaf is a tile entry with run length 0.
    let nested = directory(&[(0, 0, 3, 1)]);
    let root = directory(&[(0, 0, nested.len() as u64, 1)]);
    assert_eq!(error(&archive(&root, &nested, 10, NONE)), "invalid PMTiles tile run length");
}

#[test]
fn metadata_is_checked_last() {
    let root = directory(&[(0, 1, 10, 1)]);
    let mut bytes = archive(&root, &[], 10, NONE);
    let metadata_at = 127 + root.len();
    bytes[metadata_at] = b'[';
    bytes[metadata_at + 1] = b']';
    assert_eq!(error(&bytes), "PMTiles metadata must be a JSON object");
    bytes[metadata_at + 1] = b'x';
    assert_eq!(error(&bytes), "PMTiles metadata is not valid JSON");
    // The root directory decodes before anything is checked.
    bytes[127] = 9;
    assert_eq!(error(&bytes), "Expected varint not more than 10 bytes");
}

#[test]
fn packs_an_archive_from_the_cli() {
    let dir = Dir::new("pmtiles-archive");
    let leaf = gzip(&directory(&[(0, 1, 9000, 1), (1, 2, 9000, 9001), (5, 1, 9000, 18001)]));
    let root = directory(&[(0, 0, leaf.len() as u64, 1)]);
    dir.write("m.pmtiles", &archive(&root, &leaf, 27000, GZIP));
    // Recorded from tools/pack.ts on the same archive.
    let run = dir.run("m.pmtiles --tile-group 0");
    assert_eq!((run.status, run.stdout.as_str()), (0, "bafyreielcemmxes7dvyt64ue72dzeia5asmrlakfm7vak6dukyugqde3re\n"));
    let summary = "proofs: m.pmtiles.proofs/ (8 leaves, 5 files, descriptor 231 bytes)\ntile group: 0 bytes\n";
    assert_eq!(run.stderr, format!("{summary}map: bafkr4iebjcuyrwhsljrwhjsv5zuk6tuuz6gu3h2gzpf5uqvufurhsqmh6e\n"));
    // The default tile group, 16 KiB here, keeps every shard in the
    // descriptor. One chunk: the UnixFS root is the file's raw sha2-256 CID.
    let run = dir.run("m.pmtiles --unixfs --full-car pin.car");
    assert_eq!((run.status, run.stdout.as_str()), (0, "bafyreicu3odqevrtgm2yl26c3w64s6s2sp67mjo7uvlhxq7xllg646ne2a\n"));
    let summary = "proofs: m.pmtiles.proofs/ (8 leaves, 5 files, descriptor 279 bytes)\ntile group: 16384 bytes\n";
    let map = "map: bafkr4iebjcuyrwhsljrwhjsv5zuk6tuuz6gu3h2gzpf5uqvufurhsqmh6e\n";
    let unixfs = "unixfs: bafkreidqpiif6qk2n667lc6qnx3lws6vjc7pyvuxgapcoutxz4ndtdgoai\n";
    assert_eq!(run.stderr, format!("{summary}{map}{unixfs}"));
    let car_sha = hex(&sha256(&dir.read("pin.car")));
    assert_eq!(car_sha, "7587591ccf4bdded202cb6c51d023112777b5f795b420774bc66dbd3ccf99935");
}

const TOO_MANY: &str = "PMTiles has more than 2^30 tile entries";

fn capped(bytes: &[u8], max_entries: u64) -> Result<usize, String> {
    parse_with_max_entries(bytes, max_entries).map(|p| p.tiles.records.len()).map_err(|e| e.0)
}

#[test]
fn tile_entries_are_capped_in_root_order() {
    let pair = directory(&[(0, 1, 10, 1), (1, 1, 10, 0)]);
    let empty = directory(&[]);
    let (p, e) = (pair.len() as u64, empty.len() as u64);
    // Three copies of a 2-entry leaf, then an empty one.
    let leaves = [pair.clone(), pair.clone(), pair.clone(), empty].concat();
    let ptr = |id, i: u64| (id, 0, p, i * p + 1);
    let root = directory(&[ptr(0, 0), ptr(1, 1), ptr(2, 2)]);
    let bytes = archive(&root, &leaves, 20, NONE);
    assert_eq!(capped(&bytes, 6), Ok(2));
    assert_eq!(capped(&bytes, 5), Err(TOO_MANY.into()));
    // A failing tile entry before the overflow: the cap error wins.
    let root = directory(&[(0, 1, 99, 1), ptr(1, 0), ptr(2, 1), ptr(3, 2)]);
    assert_eq!(capped(&archive(&root, &leaves, 20, NONE), 6), Err(TOO_MANY.into()));
    // A directory error before the overflow wins; one after it does not.
    let bad = |id| (id, 0, e, 3 * p + 1);
    let root = directory(&[ptr(0, 0), bad(1), ptr(2, 1), ptr(3, 2)]);
    assert_eq!(capped(&archive(&root, &leaves, 20, NONE), 5), Err("Empty directory is invalid".into()));
    let root = directory(&[ptr(0, 0), ptr(1, 1), ptr(2, 2), bad(3)]);
    assert_eq!(capped(&archive(&root, &leaves, 20, NONE), 5), Err(TOO_MANY.into()));
    assert_eq!(parse(&archive(&root, &leaves, 20, NONE)).err().unwrap().0, "Empty directory is invalid");
}

#[test]
fn the_entry_cap_holds_across_batches() {
    let leaves: Vec<Vec<u8>> = (0..2500).map(|i| directory(&[(i, 1, 1, i + 1)])).collect();
    let starts: Vec<usize> = leaves.iter().scan(0, |at, leaf| Some(std::mem::replace(at, *at + leaf.len()))).collect();
    let root: Vec<_> = (0..2500).map(|i| (i as u64, 0, leaves[i].len() as u64, starts[i] as u64 + 1)).collect();
    let bytes = archive(&directory(&root), &leaves.concat(), 2500, NONE);
    assert_eq!(capped(&bytes, 2500), Ok(2500));
    assert_eq!(capped(&bytes, 2499), Err(TOO_MANY.into()));
    assert_eq!(capped(&bytes, 10), Err(TOO_MANY.into()));
}

// The default tile group against small top-meta limits, as tools/pack.ts
// chooses it on the same archives.
#[test]
fn tile_group_vectors() {
    for case in fixture("tile-group.json").at("cases").arr() {
        let bytes = unhex(case.at("archive").str());
        let parsed = parse(&bytes).unwrap();
        for choice in case.at("choices").arr() {
            let top_max = choice.at("topMaxEntries").u64() as usize;
            let chosen = choose_tile_group(&parsed, bytes.len() as u64, Limits { top_max, ..Limits::default() });
            assert_eq!(chosen, Ok(choice.at("tileGroup").u64()), "{}, top meta of {top_max}", case.at("name").str());
        }
    }
}
