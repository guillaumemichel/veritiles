mod common;

use common::{cid_from_text, fixture, hex, sha256, unhex};
use veritiles_pack::codec::{cbor, cid};
use veritiles_pack::proof::descriptor;
use veritiles_pack::proof::format::{KIND_SHARD, push_meta_record};

#[test]
fn cid_vectors() {
    for case in fixture("cid.json").at("cases").arr() {
        let codec = case.at("codec").u64() as u8;
        let bytes = cid::cid_bytes(codec, &sha256(&unhex(case.at("input").str())));
        assert_eq!(hex(&bytes), case.at("bytes").str());
        assert_eq!(cid::to_text(&bytes), case.at("text").str());
    }
}

#[test]
fn drisl_uint_vectors() {
    for case in fixture("drisl.json").at("uint").arr() {
        assert_eq!(hex(&cbor::encode_uint(case.at("value").u64())), case.at("encoded").str());
    }
}

#[test]
fn drisl_bytes_head_vectors() {
    for case in fixture("drisl.json").at("bytesHead").arr() {
        let length = case.at("length").u64() as usize;
        assert_eq!(hex(&cbor::bytes_head(length)), case.at("encoded").str());
    }
}

// The fixture's top metas: N shard entries of 2^32 bytes each, at 0, 2^32, …,
// one leaf per shard, leaf digest sha256(u64le(offset)).
fn top_meta(entries: u64) -> Vec<u8> {
    let mut meta = Vec::new();
    for i in 0..entries {
        let mut shard = vec![0u8; 4];
        shard.extend_from_slice(&sha256(&(i << 32).to_le_bytes()));
        push_meta_record(&mut meta, KIND_SHARD, 1 << 32, &sha256(&shard));
    }
    meta
}

#[test]
fn descriptor_vectors() {
    for case in fixture("descriptor.json").at("cases").arr() {
        let meta = top_meta(case.at("topMetaEntries").u64());
        assert_eq!(hex(&sha256(&meta)), case.at("topMetaSha256").str());
        let map = cid_from_text(case.at("mapCid").str());
        let unixfs = case.get("unixfsCid").map(|c| cid_from_text(c.str()));
        let bytes = descriptor::encode(&map, unixfs.as_ref(), &meta, case.at("mapSize").u64());
        if let Some(want) = case.get("descriptor") {
            assert_eq!(hex(&bytes), want.str());
        }
        assert_eq!(hex(&sha256(&bytes)), case.at("descriptorSha256").str());
        let anchor = cid::cid_bytes(cid::DAG_CBOR, &sha256(&bytes));
        assert_eq!(cid::to_text(&anchor), case.at("anchor").str());
    }
}
