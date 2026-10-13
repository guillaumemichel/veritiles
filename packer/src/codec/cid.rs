// CIDv1 with a 32-byte digest: sha2-256, except a descriptor's map, which is
// raw BLAKE3 (BDASL). Text form is multibase base32 lowercase ('b'), no
// padding.
use crate::codec::{DIGEST_LENGTH, Digest};
use crate::error::Result;

pub const RAW: u8 = 0x55;
pub const DAG_PB: u8 = 0x70;
pub const DAG_CBOR: u8 = 0x71;
const CID_V1: u8 = 0x01;
pub(crate) const SHA2_256: u8 = 0x12;
pub(crate) const BLAKE3: u8 = 0x1e;
const PREFIX_LENGTH: usize = 4;
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// A binary CIDv1: version, codec, multihash code, digest length, digest.
pub type CidBytes = [u8; PREFIX_LENGTH + DIGEST_LENGTH];

/// A sha2-256 CID. `codec` must be a one-byte multicodec (raw, dag-pb, dag-cbor).
pub fn cid_bytes(codec: u8, digest: &Digest) -> CidBytes {
    cid_with(codec, SHA2_256, digest)
}

/// A descriptor's map: the raw BLAKE3 CID of the whole file.
pub fn map_cid_bytes(digest: &Digest) -> CidBytes {
    cid_with(RAW, BLAKE3, digest)
}

fn cid_with(codec: u8, hash: u8, digest: &Digest) -> CidBytes {
    debug_assert!(codec < 0x80);
    let mut out = [0; PREFIX_LENGTH + DIGEST_LENGTH];
    out[..PREFIX_LENGTH].copy_from_slice(&[CID_V1, codec, hash, DIGEST_LENGTH as u8]);
    out[PREFIX_LENGTH..].copy_from_slice(digest);
    out
}

pub fn to_text(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(1 + bytes.len() * 8 / 5 + 1);
    out.push('b');
    let (mut value, mut bits) = (0u32, 0u32);
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((value >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

// Rejects unknown characters and non-zero trailing bits, so every accepted
// string has exactly one byte interpretation.
pub(crate) fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let (mut value, mut bits) = (0u32, 0u32);
    for ch in text.bytes() {
        let digit = BASE32.iter().position(|&c| c == ch)? as u32;
        value = (value << 5) | digit;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((value >> bits) as u8);
        }
        value &= (1 << bits) - 1;
    }
    (value == 0).then_some(out)
}

/// A CID read the way the TS client reads one (src/cid.ts): varints of up
/// to 5 bytes, not necessarily minimal, and any codec, hash, or length.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CidParts<'a> {
    pub(crate) codec: u64,
    pub(crate) hash: u64,
    pub(crate) digest: &'a [u8],
}

/// src/cid.ts decodeCidBytes: one embedded CID at `*pos`, digest included.
pub(crate) fn decode_cid<'a>(bytes: &'a [u8], pos: &mut usize, label: &str) -> Result<CidParts<'a>> {
    let (codec, hash, length) = cid_prefix(bytes, pos, label)?;
    let end = pos.saturating_add(length as usize);
    if length > bytes.len() as u64 || end > bytes.len() {
        return Err(format!("{label}: truncated CID digest").into());
    }
    let digest = &bytes[*pos..end];
    *pos = end;
    Ok(CidParts { codec, hash, digest })
}

/// src/cid.ts parseCid: a whole text CID; the digest is all that remains.
pub(crate) fn parse_cid<'a>(bytes: &'a [u8], label: &str) -> Result<CidParts<'a>> {
    let mut pos = 0;
    let (codec, hash, length) = cid_prefix(bytes, &mut pos, label)?;
    let digest = &bytes[pos..];
    if digest.len() as u64 != length {
        return Err(format!("{label}: CID digest length mismatch").into());
    }
    Ok(CidParts { codec, hash, digest })
}

fn cid_prefix(bytes: &[u8], pos: &mut usize, label: &str) -> Result<(u64, u64, u64)> {
    if read_varint(bytes, pos, label)? != 1 {
        return Err(format!("{label}: CID is not version 1").into());
    }
    let codec = read_varint(bytes, pos, label)?;
    let hash = read_varint(bytes, pos, label)?;
    Ok((codec, hash, read_varint(bytes, pos, label)?))
}

// Unsigned LEB128, at most 5 bytes (< 2^35).
fn read_varint(bytes: &[u8], pos: &mut usize, label: &str) -> Result<u64> {
    let mut value = 0;
    for shift in (0..35).step_by(7) {
        let &byte = bytes.get(*pos).ok_or_else(|| format!("{label}: truncated CID"))?;
        *pos += 1;
        value += u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Ok(value);
        }
    }
    Err(format!("{label}: CID varint too long").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_cids_are_raw_blake3() {
        let map = map_cid_bytes(&[7; 32]);
        assert_eq!(map[..4], [1, 0x55, 0x1e, 0x20]);
        assert!(to_text(&map).starts_with("bafkr4i"));
    }

    #[test]
    fn reads_cids_like_the_client() {
        let digest = [7u8; 32];
        let loose = [&[0x81, 0x00, 0xf1, 0x00, 0x12, 0x20][..], &digest].concat();
        let parts = parse_cid(&loose, "x").unwrap();
        assert_eq!((parts.codec, parts.hash, parts.digest), (0x71, 0x12, &digest[..]));
        let error = |bytes: &[u8]| parse_cid(bytes, "x").unwrap_err().0;
        assert_eq!(error(&[2]), "x: CID is not version 1");
        assert_eq!(error(&[1, 0x71]), "x: truncated CID");
        assert_eq!(error(&[1, 0xff, 0xff, 0xff, 0xff, 0xff]), "x: CID varint too long");
        assert_eq!(error(&[1, 0x71, 0x12, 0x20, 0]), "x: CID digest length mismatch");
        let mut pos = 0;
        let embedded = [&[1, 0x55, 0x12, 0x20][..], &digest, &[9]].concat();
        assert_eq!(decode_cid(&embedded, &mut pos, "x").unwrap().codec, 0x55);
        assert_eq!(pos, 36);
        let mut pos = 0;
        assert_eq!(decode_cid(&[1, 0x55, 0x12, 0x20, 0], &mut pos, "x").unwrap_err().0, "x: truncated CID digest");
    }
}
