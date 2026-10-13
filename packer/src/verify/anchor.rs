// The anchor gate of src/cid.ts parseFileAnchor: the client accepts any
// base32 CIDv1 text whose hash is sha2-256 with a 32-byte digest and whose
// codec is dag-cbor, varints minimal or not. Verify accepts exactly that.
use crate::codec::Digest;
use crate::codec::cid::{DAG_CBOR, SHA2_256, base32_decode, parse_cid};
use crate::error::Result;

/// The descriptor digest the anchor names.
pub fn parse_file_anchor(text: &str) -> Result<Digest> {
    let body = text.strip_prefix('b').filter(|body| !body.is_empty());
    let body = body.ok_or("anchor: CID is not multibase base32")?;
    let bytes = base32_decode(body).ok_or("anchor: CID is not canonical base32")?;
    let cid = parse_cid(&bytes, "anchor")?;
    let digest: Option<Digest> = cid.digest.try_into().ok().filter(|_| cid.hash == u64::from(SHA2_256));
    let digest = digest.ok_or("anchor: CID must be sha2-256 with a 32-byte digest")?;
    if cid.codec != u64::from(DAG_CBOR) {
        return Err("anchor: CID codec must be dag-cbor (a proof descriptor)".into());
    }
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::cid::{RAW, cid_bytes, to_text};

    fn error(text: &str) -> String {
        parse_file_anchor(text).unwrap_err().0
    }

    #[test]
    fn anchor_rules() {
        let digest = [5; 32];
        assert_eq!(parse_file_anchor(&to_text(&cid_bytes(DAG_CBOR, &digest))).unwrap(), digest);
        assert_eq!(error(""), "anchor: CID is not multibase base32");
        assert_eq!(error("b"), "anchor: CID is not multibase base32");
        assert_eq!(error("Bafy"), "anchor: CID is not multibase base32");
        assert_eq!(error("bafy!"), "anchor: CID is not canonical base32");
        assert_eq!(error("bab"), "anchor: CID is not canonical base32");
        assert_eq!(
            error(&to_text(&cid_bytes(RAW, &digest))),
            "anchor: CID codec must be dag-cbor (a proof descriptor)"
        );
        let sha512 = [&[1, 0x71, 0x13, 0x20][..], &digest].concat();
        assert_eq!(error(&to_text(&sha512)), "anchor: CID must be sha2-256 with a 32-byte digest");
        let short = [&[1, 0x71, 0x12, 0x1f][..], &digest[..31]].concat();
        assert_eq!(error(&to_text(&short)), "anchor: CID must be sha2-256 with a 32-byte digest");
        assert_eq!(error(&to_text(&[2, 0x71])), "anchor: CID is not version 1");
    }
}
