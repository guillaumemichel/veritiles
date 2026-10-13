// MASL manifest encoding against tools/gen-rust-vectors.ts (encodeManifest).
mod common;

use common::{Json, fixture, hex, sha256};
use veritiles_pack::codec::cid::{RAW, cid_bytes};
use veritiles_pack::manifest::{Resource, encode};

fn resources(case: &Json) -> Vec<Resource> {
    let count = case.at("count").u64() as usize;
    let paths: Vec<String> = match case.get("paths") {
        Some(paths) => paths.arr().iter().map(|p| p.str().to_string()).collect(),
        None => (0..count).map(|i| format!("/f{i}")).collect(),
    };
    let content_type = case.get("contentType").map(|t| t.str().to_string());
    let size = case.get("size").map(Json::u64);
    let resource = |(i, path): (usize, String)| Resource {
        path,
        src: cid_bytes(RAW, &sha256(&[(i % 256) as u8, (i >> 8) as u8])),
        size: size.unwrap_or(i as u64 * 1000),
        content_type: content_type.clone().filter(|_| i % 2 == 0),
    };
    paths.into_iter().enumerate().map(resource).collect()
}

#[test]
fn manifest_vectors() {
    for case in fixture("manifest.json").at("cases").arr() {
        let name = case.at("name").str();
        let result = encode(resources(case));
        if let Some(error) = case.get("error") {
            assert_eq!(result.unwrap_err().0, error.str(), "{name}");
            continue;
        }
        let manifest = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        if let Some(expected) = case.get("manifest") {
            assert_eq!(hex(&manifest), expected.str(), "{name}");
        }
        assert_eq!(hex(&sha256(&manifest)), case.at("manifestSha256").str(), "{name}");
    }
}
