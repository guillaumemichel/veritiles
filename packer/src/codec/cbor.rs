// DRISL (deterministic CBOR) heads: the shortest form, as tools/pack.ts emits.
use crate::codec::cid::CidBytes;

const MAJOR_UINT: u8 = 0;
const MAJOR_BYTES: u8 = 2;
const MAJOR_TEXT: u8 = 3;
const MAJOR_MAP: u8 = 5;
/// Tag 42, then a 37-byte string: the 0x00 multibase-identity prefix and
/// the CID.
pub const TAG42_CID: &[u8] = &[0xd8, 0x2a, 0x58, 0x25, 0x00];

pub fn encode_uint(value: u64) -> Vec<u8> {
    head(MAJOR_UINT, value)
}

/// A byte-string head. Descriptor byte strings stay under 64 KiB.
pub fn bytes_head(length: usize) -> Vec<u8> {
    assert!(length <= 0xffff, "bad CBOR length {length}");
    head(MAJOR_BYTES, length as u64)
}

/// A text string: head and UTF-8 bytes. Callers keep it under 64 KiB.
pub fn text(value: &str) -> Vec<u8> {
    let mut out = head(MAJOR_TEXT, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
    out
}

pub fn map_head(count: usize) -> Vec<u8> {
    head(MAJOR_MAP, count as u64)
}

/// A CID link (tag 42).
pub fn push_cid(out: &mut Vec<u8>, cid: &CidBytes) {
    out.extend_from_slice(TAG42_CID);
    out.extend_from_slice(cid);
}

fn head(major: u8, value: u64) -> Vec<u8> {
    let base = major << 5;
    if value < 24 {
        return vec![base | value as u8];
    }
    let (marker, width) = match value {
        0..=0xff => (24, 1),
        0x100..=0xffff => (25, 2),
        0x1_0000..=0xffff_ffff => (26, 4),
        _ => (27, 8),
    };
    let mut out = vec![base | marker];
    out.extend_from_slice(&value.to_be_bytes()[8 - width..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "bad CBOR length")]
    fn bytes_head_rejects_over_two_bytes() {
        bytes_head(0x1_0000);
    }
}
