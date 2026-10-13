// `pack verify`: every rule of the full check, in process, on small packages
// packed with tiny tree limits or built by hand. CLI runs live in cli.rs (a
// binary that forks must not also run rayon in process: tarpaulin's ptrace
// engine crashes on the mix). The cross check against the TS client is
// test/pack-diff.test.ts.
mod common;

use std::fs;
use std::path::Path;

use common::run::Dir;
use common::{blake3, pattern, sha256};
use veritiles_pack::args::VerifyArgs;
use veritiles_pack::codec::cid::{DAG_CBOR, DAG_PB, RAW, cid_bytes, map_cid_bytes, to_text};
use veritiles_pack::input::Input;
use veritiles_pack::pipeline::hash_and_write_shards;
use veritiles_pack::plan::Leaves;
use veritiles_pack::proof::descriptor;
use veritiles_pack::proof::format::{KIND_DIR, KIND_SHARD, push_meta_record, push_shard_record};
use veritiles_pack::proof::tree::{Limits, plan};
use veritiles_pack::verify::verify;

// Packs `bytes` into `dir/p` with tiny tree limits, so a few hundred bytes
// reach nested meta directories. Returns the anchor.
fn pack_small(dir: &Path, bytes: &[u8], chunk: u64, limits: Limits) -> String {
    let leaves = Leaves::Fixed { chunk, size: bytes.len() as u64 };
    let band = 0..leaves.count();
    let layout = plan(&leaves, std::slice::from_ref(&band), limits).unwrap();
    let out = dir.join("p");
    for meta in &layout.metas {
        fs::create_dir_all(out.join(&meta.path).parent().unwrap()).unwrap();
    }
    fs::create_dir_all(&out).unwrap();
    let input = Input::Read(bytes.to_vec());
    let hashed = hash_and_write_shards(&input, &leaves, &layout, &out.to_string_lossy(), None).unwrap();
    let (metas, top) = layout.seal(&hashed.shard_digests);
    for (meta, content) in layout.metas.iter().zip(&metas) {
        fs::write(out.join(&meta.path), content).unwrap();
    }
    let root = descriptor::encode(&map_cid_bytes(&hashed.map_digest), None, &top, bytes.len() as u64);
    write_root(dir, &root)
}

fn write_root(dir: &Path, root: &[u8]) -> String {
    fs::create_dir_all(dir.join("p")).unwrap();
    fs::write(dir.join("p/root"), root).unwrap();
    to_text(&cid_bytes(DAG_CBOR, &sha256(root)))
}

fn check(dir: &Path, cid: &str) -> Result<(), String> {
    let args = VerifyArgs {
        cid: cid.into(),
        file: dir.join("f").to_string_lossy().into_owned(),
        proofs: dir.join("p").to_string_lossy().into_owned(),
    };
    verify(&args).map_err(|e| e.0)
}

fn fails_with(result: Result<(), String>, needle: &str) {
    let err = result.expect_err("verify must fail");
    assert!(err.contains(needle), "{err:?} lacks {needle:?}");
}

fn flip(path: &Path, at: usize) {
    let mut bytes = fs::read(path).unwrap();
    bytes[at] ^= 0x01;
    fs::write(path, bytes).unwrap();
}

#[test]
fn nested_directories_verify_and_catch_tampering() {
    let dir = Dir::new("verify-nested");
    let bytes = pattern(3000);
    dir.write("f", &bytes);
    // 3000 one-byte leaves in 2 shards: top_max 1 turns the band into a directory.
    let anchor = pack_small(&dir.0, &bytes, 1, Limits { meta_max: 3, top_max: 1, ..Limits::default() });
    check(&dir.0, &anchor).unwrap();
    let meta = dir.0.join("p/0/meta");
    assert!(meta.exists(), "the band is a directory");
    flip(&meta, 50);
    fails_with(check(&dir.0, &anchor), "0/meta: digest mismatch");
    // The file's size is checked before the tree is walked.
    dir.write("f", &bytes[..10]);
    fails_with(check(&dir.0, &anchor), "file is 10 bytes, descriptor says 3000");
}

#[test]
fn deeply_nested_metas_verify() {
    let dir = Dir::new("verify-deep");
    let bytes = pattern(40 * 1820 + 3);
    dir.write("f", &bytes);
    let anchor = pack_small(&dir.0, &bytes, 1, Limits { meta_max: 3, top_max: 2, ..Limits::default() });
    check(&dir.0, &anchor).unwrap();
}

#[test]
fn content_tampering_fails() {
    let dir = Dir::new("verify-content");
    let bytes = pattern(4000);
    dir.write("f", &bytes);
    let anchor = pack_small(&dir.0, &bytes, 7, Limits::default());
    check(&dir.0, &anchor).unwrap();
    let mut flipped = bytes.clone();
    flipped[3999] ^= 1;
    dir.write("f", &flipped);
    fails_with(check(&dir.0, &anchor), "leaf at 3997+3 (0): digest mismatch");
    dir.write("f", &bytes[..3999]);
    fails_with(check(&dir.0, &anchor), "file is 3999 bytes, descriptor says 4000");
    dir.write("f", &[&bytes[..], &[0]].concat());
    fails_with(check(&dir.0, &anchor), "file is 4001 bytes, descriptor says 4000");
    dir.write("f", &bytes);
    flip(&dir.0.join("p/0"), 9);
    fails_with(check(&dir.0, &anchor), "0: digest mismatch");
}

#[test]
fn proof_file_errors() {
    let dir = Dir::new("verify-files");
    let bytes = pattern(100);
    dir.write("f", &bytes);
    let anchor = pack_small(&dir.0, &bytes, 10, Limits::default());
    fs::rename(dir.0.join("p/0"), dir.0.join("p/0.bak")).unwrap();
    fails_with(check(&dir.0, &anchor), "ENOENT: no such file or directory, open");
    fs::rename(dir.0.join("p/0.bak"), dir.0.join("p/0")).unwrap();
    flip(&dir.0.join("p/root"), 3);
    fails_with(check(&dir.0, &anchor), "root: digest mismatch");
    let raw = to_text(&cid_bytes(RAW, &sha256(b"x")));
    fails_with(check(&dir.0, &raw), "anchor: CID codec must be dag-cbor (a proof descriptor)");
    fs::write(dir.0.join("p/root"), vec![0; 256 * 1024 + 1]).unwrap();
    fails_with(check(&dir.0, &anchor), "root: over the 262144-byte cap");
}

// A hand-built shard over the whole file, leaves starting at `leaf_offsets`.
struct Handmade {
    shard: Vec<u8>,
}

impl Handmade {
    fn new(file: &[u8], leaf_offsets: &[u32]) -> Handmade {
        let mut shard = Vec::new();
        for (i, &rel) in leaf_offsets.iter().enumerate() {
            let end = leaf_offsets.get(i + 1).map_or(file.len(), |&next| next as usize);
            push_shard_record(&mut shard, rel, &sha256(&file[rel as usize..end]));
        }
        Handmade { shard }
    }

    fn top(&self, length: u64) -> Vec<u8> {
        let mut top = Vec::new();
        push_meta_record(&mut top, KIND_SHARD, length, &sha256(&self.shard));
        top
    }
}

#[test]
fn coverage_and_map_rules() {
    let dir = Dir::new("verify-coverage");
    let file = pattern(300);
    dir.write("f", &file);
    let made = Handmade::new(&file, &[0, 100, 200]);
    fs::create_dir_all(dir.0.join("p/0")).unwrap();
    fs::write(dir.0.join("p/0/0"), &made.shard).unwrap();
    // A directory whose meta covers less than its parent committed.
    let mut sub = Vec::new();
    push_meta_record(&mut sub, KIND_SHARD, 300, &sha256(&made.shard));
    fs::write(dir.0.join("p/0/meta"), &sub).unwrap();
    let mut top = Vec::new();
    push_meta_record(&mut top, KIND_DIR, 301, &sha256(&sub));
    let map = map_cid_bytes(&blake3(&file));
    let anchor = write_root(&dir.0, &descriptor::encode(&map, None, &top, 301));
    dir.write("f", &pattern(301));
    fails_with(check(&dir.0, &anchor), "0/meta covers 300 bytes, expected 301");
    dir.write("f", &file);
    // The map CID must hash the whole file even when every leaf matches.
    fs::remove_dir_all(dir.0.join("p/0")).unwrap();
    fs::write(dir.0.join("p/0"), &made.shard).unwrap();
    let wrong = map_cid_bytes(&blake3(b"other"));
    let anchor = write_root(&dir.0, &descriptor::encode(&wrong, None, &made.top(300), 300));
    fails_with(check(&dir.0, &anchor), "map CID does not match the file");
    let unixfs = cid_bytes(DAG_PB, &sha256(b"u"));
    let anchor = write_root(&dir.0, &descriptor::encode(&map, Some(&unixfs), &made.top(300), 300));
    check(&dir.0, &anchor).unwrap();
}

#[test]
fn shard_structure_rules() {
    let dir = Dir::new("verify-shards");
    let file = pattern(300);
    dir.write("f", &file);
    let map = map_cid_bytes(&blake3(&file));
    let cases: [(&[u32], u64, &str); 3] = [
        (&[5, 100], 300, "0: first record must start the shard"),
        (&[0, 100, 100], 300, "0: offsets not strictly ascending"),
        (&[0, 100, 300], 300, "0: record at 300 outside the 300-byte span"),
    ];
    for (offsets, length, message) in cases {
        let made = Handmade::new(&[&file[..], &[0; 10]].concat(), offsets);
        fs::create_dir_all(dir.0.join("p")).unwrap();
        fs::write(dir.0.join("p/0"), &made.shard).unwrap();
        let anchor = write_root(&dir.0, &descriptor::encode(&map, None, &made.top(length), length));
        fails_with(check(&dir.0, &anchor), message);
    }
}

#[test]
fn accepts_any_anchor_the_client_accepts() {
    let dir = Dir::new("verify-anchor");
    let bytes = pattern(100);
    dir.write("f", &bytes);
    let anchor = pack_small(&dir.0, &bytes, 10, Limits::default());
    let digest = sha256(&fs::read(dir.0.join("p/root")).unwrap());
    // Non-minimal varints for the version and codec still name the descriptor.
    let loose = [&[0x81, 0x00, 0xf1, 0x00, 0x12, 0x20][..], &digest].concat();
    check(&dir.0, &to_text(&loose)).unwrap();
    check(&dir.0, &anchor).unwrap();
}
