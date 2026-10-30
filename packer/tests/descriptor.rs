// decodeDescriptor parity: the canonical descriptor and every mutation in
// the TS-generated vectors decode, or fail with the TS message.
mod common;

use anymirror_pack::proof::descriptor::decode;
use common::{fixture, hex, unhex};

#[test]
fn decode_vectors() {
    for case in fixture("descriptor-decode.json").at("cases").arr() {
        let name = case.at("name").str();
        let result = decode(&unhex(case.at("descriptor").str()));
        if let Some(error) = case.get("error") {
            assert_eq!(result.unwrap_err().0, error.str(), "{name}");
            continue;
        }
        let descriptor = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(hex(&descriptor.map_digest), case.at("mapDigest").str(), "{name}");
        assert_eq!(descriptor.map_size, case.at("mapSize").u64(), "{name}");
        assert_eq!(hex(&descriptor.top_meta), case.at("topMeta").str(), "{name}");
    }
}
