// Binary proof records (src/proof-format.ts): fixed-width little-endian.
// Encoders for the packer; decoders and checks for verify.
//   shard file := ( u32le(relativeOffset) digest32 )+          36 B records
//   meta file  := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+ 41 B records

use crate::codec::{DIGEST_LENGTH, Digest, MAX_SAFE_INTEGER};
use crate::error::Result;

pub const SHARD_RECORD_SIZE: usize = 4 + DIGEST_LENGTH;
pub const SHARD_FILE_CAP: usize = 64 * 1024;
pub const MAX_SHARD_RECORDS: usize = SHARD_FILE_CAP / SHARD_RECORD_SIZE;
pub const META_RECORD_SIZE: usize = 1 + 8 + DIGEST_LENGTH;
pub const META_FILE_CAP: usize = 256 * 1024;
pub const DESCRIPTOR_CAP: usize = 256 * 1024;
pub const KIND_SHARD: u8 = 0;
pub const KIND_DIR: u8 = 1;

pub fn push_shard_record(out: &mut Vec<u8>, relative_offset: u32, digest: &Digest) {
    out.extend_from_slice(&relative_offset.to_le_bytes());
    out.extend_from_slice(digest);
}

pub fn push_meta_record(out: &mut Vec<u8>, kind: u8, length: u64, digest: &Digest) {
    out.push(kind);
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(digest);
}

/// Shard file name: lowercase hex of the absolute start offset, unpadded.
pub fn shard_name(start: u64) -> String {
    format!("{start:x}")
}

/// A meta record with its absolute start (a prefix sum over earlier records).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaEntry {
    pub kind: u8,
    pub start: u64,
    pub length: u64,
    pub digest: Digest,
}

/// A leaf from a validated shard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leaf {
    pub offset: u64,
    pub length: u64,
    pub digest: Digest,
}

/// src/proof-format.ts decodeMeta: every record and the bytes they cover.
pub fn decode_meta(bytes: &[u8], start: u64) -> Result<(Vec<MetaEntry>, u64)> {
    if bytes.is_empty() {
        return Err("meta: empty file".into());
    }
    if !bytes.len().is_multiple_of(META_RECORD_SIZE) {
        return Err(format!("meta: size {} not a multiple of {META_RECORD_SIZE}", bytes.len()).into());
    }
    let mut entries = Vec::with_capacity(bytes.len() / META_RECORD_SIZE);
    let mut offset = start;
    for record in bytes.chunks_exact(META_RECORD_SIZE) {
        let kind = record[0];
        if kind != KIND_SHARD && kind != KIND_DIR {
            return Err(format!("meta: unknown entry kind {kind}").into());
        }
        let length = u64::from_le_bytes(record[1..9].try_into().expect("8 bytes"));
        if length > MAX_SAFE_INTEGER {
            return Err("meta: value exceeds 2^53".into());
        }
        if length == 0 {
            return Err("meta: zero-length range".into());
        }
        let digest = record[9..].try_into().expect("32 bytes");
        entries.push(MetaEntry { kind, start: offset, length, digest });
        offset = offset.saturating_add(length);
    }
    Ok((entries, offset - start))
}

/// src/proof-format.ts validateShard: framing, the first record at the
/// shard's start, strict ascent, the last record inside the span.
pub fn validate_shard(bytes: &[u8], span: u64, label: &str) -> Result<()> {
    if bytes.is_empty() {
        return Err(format!("{label}: empty shard").into());
    }
    if !bytes.len().is_multiple_of(SHARD_RECORD_SIZE) {
        return Err(format!("{label}: size {} not a multiple of {SHARD_RECORD_SIZE}", bytes.len()).into());
    }
    if bytes.len() > MAX_SHARD_RECORDS * SHARD_RECORD_SIZE {
        return Err(format!("{label}: exceeds the {MAX_SHARD_RECORDS}-record limit").into());
    }
    let mut previous: Option<u64> = None;
    for record in bytes.chunks_exact(SHARD_RECORD_SIZE) {
        let relative = relative_offset(record);
        if previous.is_none() && relative != 0 {
            return Err(format!("{label}: first record must start the shard").into());
        }
        if previous.is_some_and(|p| relative <= p) {
            return Err(format!("{label}: offsets not strictly ascending").into());
        }
        previous = Some(relative);
    }
    let last = previous.expect("at least one record");
    if last >= span {
        return Err(format!("{label}: record at {last} outside the {span}-byte span").into());
    }
    Ok(())
}

/// The leaves of a validated shard starting at `start` and covering `span`
/// bytes: each record runs to the next, the last to the span's end.
pub fn shard_leaves(bytes: &[u8], start: u64, span: u64) -> Vec<Leaf> {
    let records: Vec<&[u8]> = bytes.chunks_exact(SHARD_RECORD_SIZE).collect();
    let leaf = |(i, record): (usize, &&[u8])| {
        let relative = relative_offset(record);
        let next = records.get(i + 1).map_or(span, |next| relative_offset(next));
        let digest = record[4..].try_into().expect("32 bytes");
        Leaf { offset: start + relative, length: next - relative, digest }
    };
    records.iter().enumerate().map(leaf).collect()
}

fn relative_offset(record: &[u8]) -> u64 {
    u64::from(u32::from_le_bytes(record[..4].try_into().expect("4 bytes")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(records: &[(u8, u64)]) -> Vec<u8> {
        let mut out = Vec::new();
        records.iter().for_each(|&(kind, length)| push_meta_record(&mut out, kind, length, &[kind; 32]));
        out
    }

    fn shard(offsets: &[u32]) -> Vec<u8> {
        let mut out = Vec::new();
        offsets.iter().for_each(|&rel| push_shard_record(&mut out, rel, &[rel as u8; 32]));
        out
    }

    fn meta_error(bytes: &[u8]) -> String {
        decode_meta(bytes, 0).unwrap_err().0
    }

    #[test]
    fn meta_records_are_prefix_sums() {
        let (entries, covered) = decode_meta(&meta(&[(0, 5), (1, 7)]), 100).unwrap();
        assert_eq!(covered, 12);
        assert_eq!((entries[1].kind, entries[1].start, entries[1].length), (1, 105, 7));
    }

    #[test]
    fn meta_rules() {
        assert_eq!(meta_error(&[]), "meta: empty file");
        assert_eq!(meta_error(&[0; 40]), "meta: size 40 not a multiple of 41");
        assert_eq!(meta_error(&meta(&[(2, 1)])), "meta: unknown entry kind 2");
        assert_eq!(meta_error(&meta(&[(0, 1 << 53)])), "meta: value exceeds 2^53");
        assert_eq!(meta_error(&meta(&[(0, 0)])), "meta: zero-length range");
        let (_, covered) = decode_meta(&meta(&[(0, (1 << 53) - 1); 3]), 0).unwrap();
        assert_eq!(covered, 3 * ((1 << 53) - 1));
    }

    #[test]
    fn shard_rules() {
        let error = |bytes: &[u8], span| validate_shard(bytes, span, "s").unwrap_err().0;
        assert_eq!(error(&[], 1), "s: empty shard");
        assert_eq!(error(&[0; 35], 1), "s: size 35 not a multiple of 36");
        assert_eq!(error(&vec![0; 1821 * 36], 1), "s: exceeds the 1820-record limit");
        assert_eq!(error(&shard(&[1]), 9), "s: first record must start the shard");
        assert_eq!(error(&shard(&[0, 4, 4]), 9), "s: offsets not strictly ascending");
        assert_eq!(error(&shard(&[0, 4, 3]), 9), "s: offsets not strictly ascending");
        assert_eq!(error(&shard(&[0, 9]), 9), "s: record at 9 outside the 9-byte span");
        validate_shard(&shard(&[0, 8]), 9, "s").unwrap();
    }

    #[test]
    fn shard_leaves_run_to_the_next_record() {
        let leaves = shard_leaves(&shard(&[0, 4, 6]), 100, 9);
        let spans: Vec<(u64, u64)> = leaves.iter().map(|leaf| (leaf.offset, leaf.length)).collect();
        assert_eq!(spans, [(100, 4), (104, 2), (106, 3)]);
        assert_eq!(leaves[1].digest, [4; 32]);
    }
}
