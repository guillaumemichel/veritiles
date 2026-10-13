// The proof descriptor (`root` file): a strict DRISL map in canonical key
// order, {v, map, meta, [unixfs,] mapSize} — see src/descriptor.ts. `decode`
// copies decodeDescriptor check for check: the template bytes are fixed, so
// anything but the canonical encoding is rejected.
use crate::codec::cbor::{TAG42_CID, bytes_head, encode_uint, push_cid};
use crate::codec::cid::{BLAKE3, CidBytes, DAG_PB, RAW, SHA2_256, decode_cid};
use crate::codec::{Digest, MAX_SAFE_INTEGER};
use crate::error::Result;
use crate::proof::format::decode_meta;

const FORMAT_VERSION: u64 = 1;
// Map heads: four keys, or five with `unixfs`.
const MAP_WITHOUT_UNIXFS: u8 = 0xa4;
const MAP_WITH_UNIXFS: u8 = 0xa5;
const KEY_V: &[u8] = &[0x61, b'v'];
const KEY_MAP: &[u8] = &[0x63, b'm', b'a', b'p'];
const KEY_META: &[u8] = &[0x64, b'm', b'e', b't', b'a'];
const KEY_UNIXFS: &[u8] = &[0x66, b'u', b'n', b'i', b'x', b'f', b's'];
const KEY_MAP_SIZE: &[u8] = &[0x67, b'm', b'a', b'p', b'S', b'i', b'z', b'e'];
const TEMPLATE: &str = "descriptor: not the canonical descriptor template";

#[derive(Debug, PartialEq, Eq)]
pub struct Descriptor {
    /// The BLAKE3 digest of the whole file (the raw map CID).
    pub map_digest: Digest,
    pub map_size: u64,
    pub top_meta: Vec<u8>,
}

pub fn encode(map: &CidBytes, unixfs: Option<&CidBytes>, top_meta: &[u8], map_size: u64) -> Vec<u8> {
    let mut out = vec![if unixfs.is_some() { MAP_WITH_UNIXFS } else { MAP_WITHOUT_UNIXFS }];
    out.extend_from_slice(KEY_V);
    out.extend(encode_uint(FORMAT_VERSION));
    out.extend_from_slice(KEY_MAP);
    push_cid(&mut out, map);
    out.extend_from_slice(KEY_META);
    out.extend(bytes_head(top_meta.len()));
    out.extend_from_slice(top_meta);
    if let Some(unixfs) = unixfs {
        out.extend_from_slice(KEY_UNIXFS);
        push_cid(&mut out, unixfs);
    }
    out.extend_from_slice(KEY_MAP_SIZE);
    out.extend(encode_uint(map_size));
    out
}

pub fn decode(bytes: &[u8]) -> Result<Descriptor> {
    let mut reader = Reader { bytes, pos: 1 };
    let head = bytes.first().copied();
    if head != Some(MAP_WITHOUT_UNIXFS) && head != Some(MAP_WITH_UNIXFS) {
        return Err(TEMPLATE.into());
    }
    reader.expect(KEY_V)?;
    let version = reader.uint("descriptor: v")?;
    if version != FORMAT_VERSION {
        return Err(format!("descriptor: unsupported format version {version}").into());
    }
    reader.expect(KEY_MAP)?;
    reader.expect(TAG42_CID)?;
    let map = decode_cid(bytes, &mut reader.pos, "descriptor: map")?;
    if map.codec != u64::from(RAW) {
        return Err("descriptor: map CID codec must be raw".into());
    }
    let map_digest: Digest = match (map.hash, map.digest.try_into()) {
        (hash, Ok(digest)) if hash == u64::from(BLAKE3) => digest,
        _ => return Err("descriptor: map CID must be blake3 with a 32-byte digest".into()),
    };
    reader.expect(KEY_META)?;
    let top_meta = reader.byte_string("descriptor: meta")?.to_vec();
    if head == Some(MAP_WITH_UNIXFS) {
        reader.unixfs()?;
    }
    reader.expect(KEY_MAP_SIZE)?;
    let map_size = reader.uint("descriptor: mapSize")?;
    if reader.pos != bytes.len() {
        return Err("descriptor: trailing bytes".into());
    }
    let (_, covered) = decode_meta(&top_meta, 0)?;
    if covered != map_size {
        return Err(format!("descriptor: meta covers {covered} bytes, expected mapSize {map_size}").into());
    }
    Ok(Descriptor { map_digest, map_size, top_meta })
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn expect(&mut self, want: &[u8]) -> Result<()> {
        for &byte in want {
            if self.bytes.get(self.pos) != Some(&byte) {
                return Err(TEMPLATE.into());
            }
            self.pos += 1;
        }
        Ok(())
    }

    fn unixfs(&mut self) -> Result<()> {
        self.expect(KEY_UNIXFS)?;
        self.expect(TAG42_CID)?;
        let cid = decode_cid(self.bytes, &mut self.pos, "descriptor: unixfs")?;
        let codec_ok = cid.codec == u64::from(RAW) || cid.codec == u64::from(DAG_PB);
        if cid.hash != u64::from(SHA2_256) || cid.digest.len() != 32 || !codec_ok {
            return Err("descriptor: unixfs CID must be raw or dag-pb sha2-256 with a 32-byte digest".into());
        }
        Ok(())
    }

    // src/drisl.ts uint: canonical, below 2^53.
    fn uint(&mut self, label: &str) -> Result<u64> {
        let head = *self.bytes.get(self.pos).ok_or_else(|| format!("{label}: truncated integer"))?;
        if head <= 0x17 {
            self.pos += 1;
            return Ok(u64::from(head));
        }
        let width = match head {
            0x18 => 1,
            0x19 => 2,
            0x1a => 4,
            0x1b => 8,
            _ => return Err(format!("{label}: not an unsigned integer").into()),
        };
        let value = self.big_endian(width).ok_or_else(|| format!("{label}: truncated integer"))?;
        if value > MAX_SAFE_INTEGER {
            return Err(format!("{label}: integer exceeds 2^53").into());
        }
        let min = if width == 1 { 24 } else { 1 << (4 * width) };
        if value < min {
            return Err(format!("{label}: non-canonical integer").into());
        }
        self.pos += 1 + width;
        Ok(value)
    }

    // src/drisl.ts byteString: a 0..=0xffff length head, canonical.
    fn byte_string(&mut self, label: &str) -> Result<&[u8]> {
        let head = *self.bytes.get(self.pos).ok_or_else(|| format!("{label}: truncated byte string"))?;
        let length = match head {
            0x40..=0x57 => {
                self.pos += 1;
                usize::from(head - 0x40)
            }
            0x58 | 0x59 => self.byte_string_length(head, label)?,
            _ => return Err(format!("{label}: not a byte string").into()),
        };
        let end = self.pos + length;
        let body = self.bytes.get(self.pos..end).ok_or_else(|| format!("{label}: truncated byte string"))?;
        self.pos = end;
        Ok(body)
    }

    fn byte_string_length(&mut self, head: u8, label: &str) -> Result<usize> {
        let width = if head == 0x58 { 1 } else { 2 };
        let length = self.big_endian(width).ok_or_else(|| format!("{label}: truncated byte string"))?;
        if length < if width == 1 { 24 } else { 0x100 } {
            return Err(format!("{label}: non-canonical byte string").into());
        }
        self.pos += 1 + width;
        Ok(length as usize)
    }

    // The `width`-byte big-endian value after the head byte, if present.
    fn big_endian(&self, width: usize) -> Option<u64> {
        let body = self.bytes.get(self.pos + 1..self.pos + 1 + width)?;
        Some(body.iter().fold(0, |value, &byte| (value << 8) | u64::from(byte)))
    }
}
