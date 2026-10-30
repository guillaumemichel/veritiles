// The streaming balanced UnixFS builder and the CAR writer, against vectors
// from ipfs-unixfs-importer at a small fanout (tools/gen-rust-vectors.ts).
mod common;

use std::collections::HashSet;

use anymirror_pack::car::CarWriter;
use anymirror_pack::codec::Digest;
use anymirror_pack::codec::cid::{self, CidBytes};
use anymirror_pack::codec::varint::push_varint;
use anymirror_pack::unixfs::Builder;
use common::run::Dir;
use common::{Json, cid_from_text, fixture, hex, sha256, unhex};

// Every block the builder emits, in emission order, plus the root.
fn build(case: &Json, fanout: usize) -> (Vec<(CidBytes, Vec<u8>)>, CidBytes) {
    let chunk = case.at("chunkSize").u64() as usize;
    let input = unhex(case.at("input").str());
    let digests: Vec<Digest> =
        if input.is_empty() { vec![sha256(&[])] } else { input.chunks(chunk).map(sha256).collect() };
    let mut builder = Builder::with_shape(chunk, fanout);
    let mut blocks = Vec::new();
    let mut emit = |cid: &CidBytes, bytes: &[u8]| {
        blocks.push((*cid, bytes.to_vec()));
        Ok(())
    };
    // Split the digests unevenly, as pipeline steps would.
    let (head, tail) = digests.split_at(digests.len() / 3);
    builder.push_chunks(&input, head, &mut emit).unwrap();
    builder.push_chunks(&input, tail, &mut emit).unwrap();
    let root = builder.finish(&mut emit).unwrap();
    (blocks, root)
}

#[test]
fn unixfs_vectors() {
    let vectors = fixture("unixfs.json");
    let fanout = vectors.at("maxChildrenPerNode").u64() as usize;
    for case in vectors.at("cases").arr() {
        let name = case.at("name").str();
        let (blocks, root) = build(case, fanout);
        assert_eq!(cid::to_text(&root), case.at("root").str(), "{name}");
        let mut seen = HashSet::new();
        let unique: Vec<_> = blocks.into_iter().filter(|(cid, _)| seen.insert(*cid)).collect();
        let expected = case.at("blocks").arr();
        assert_eq!(unique.len(), expected.len(), "{name}");
        for ((cid, bytes), want) in unique.iter().zip(expected) {
            assert_eq!(cid::to_text(cid), want.at("cid").str(), "{name}");
            assert_eq!(hex(bytes), want.at("bytes").str(), "{name}");
        }
    }
}

#[test]
fn car_holds_each_block_once_in_post_order() {
    let vectors = fixture("unixfs.json");
    let fanout = vectors.at("maxChildrenPerNode").u64() as usize;
    let dir = Dir::new("car");
    let path = dir.0.join("pin.car").to_string_lossy().into_owned();
    for case in vectors.at("cases").arr() {
        let (blocks, root) = build(case, fanout);
        let mut car = CarWriter::create(&path).unwrap();
        for (cid, bytes) in &blocks {
            car.block(cid, bytes).unwrap();
        }
        car.commit(&root).unwrap();
        assert!(!dir.0.join("pin.car.tmp").exists(), "renamed by commit");
        let mut expected = hex(&[0x3a, 0xa2, 0x65]) + &hex(b"roots") + "81d82a582500" + &hex(&root);
        expected += &(hex(&[0x67]) + &hex(b"version") + "01");
        for want in case.at("blocks").arr() {
            let mut section = Vec::new();
            let bytes = unhex(want.at("bytes").str());
            push_varint(&mut section, 36 + bytes.len() as u64);
            section.extend(cid_from_text(want.at("cid").str()));
            expected += &hex(&[section, bytes].concat());
        }
        assert_eq!(hex(&dir.read("pin.car")), expected, "{}", case.at("name").str());
    }
}

#[test]
fn car_errors_read_like_node() {
    let err = CarWriter::create("/nonexistent-dir/pin.car").err().unwrap();
    assert_eq!(err.0, "ENOENT: no such file or directory, open '/nonexistent-dir/pin.car.tmp'");
    let dir = Dir::new("car-errors");
    let path = dir.0.join("pin.car").to_string_lossy().into_owned();
    let car = CarWriter::create(&path).unwrap();
    std::fs::remove_file(format!("{path}.tmp")).unwrap();
    let err = car.commit(&cid::cid_bytes(cid::RAW, &sha256(b""))).unwrap_err();
    assert_eq!(err.0, format!("ENOENT: no such file or directory, rename '{path}.tmp' -> '{path}'"));
}

#[test]
fn production_shape_reduces_a_single_chunk_to_itself() {
    let bytes = vec![7u8; 1000];
    let digest = sha256(&bytes);
    let mut builder = Builder::new();
    let mut none = |_: &CidBytes, _: &[u8]| Ok(());
    builder.push_chunks(&bytes, &[digest], &mut none).unwrap();
    assert_eq!(builder.finish(&mut none).unwrap(), cid::cid_bytes(cid::RAW, &digest));
}
