// The PMTiles v3 header and section checks of tools/pack.ts parsePmtiles.
// Offsets and lengths are JS numbers there (getUint64 rounds past 2^53), so
// they are f64 here and every check is the TS safe-integer check.
use std::ops::Range;

use crate::codec::MAX_SAFE_INTEGER;
use crate::error::Result;

pub const HEADER_SIZE: usize = 127;
/// The client's first read: the root directory must lie inside it.
pub const PROBE: u64 = 16 * 1024;
const MAGIC: &[u8; 7] = b"PMTiles";
const COMPRESSION_AT: usize = 97;
// Exact: 2^53 − 1 is a double.
const MAX_SAFE: f64 = MAX_SAFE_INTEGER as f64;

/// A section's absolute `(offset, length)`, as JS numbers.
pub type Section = (f64, f64);

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub root: Section,
    pub metadata: Section,
    pub leaves: Section,
    pub tiles: Section,
    pub compression: u8,
}

pub fn is_pmtiles_v3(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes.starts_with(MAGIC) && bytes[7] == 3
}

impl Header {
    /// Reads the header and checks the root directory and every section
    /// against the archive, recording their boundaries in `boundaries`.
    pub fn read(bytes: &[u8], boundaries: &mut Vec<u64>) -> Result<Header> {
        if !is_pmtiles_v3(bytes) {
            return Err("not a PMTiles v3 archive".into());
        }
        if bytes.len() < HEADER_SIZE {
            return Err("truncated PMTiles header".into());
        }
        let field = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap()) as f64;
        let header = Header {
            root: (field(8), field(16)),
            metadata: (field(24), field(32)),
            leaves: (field(40), field(48)),
            tiles: (field(56), field(64)),
            compression: bytes[COMPRESSION_AT],
        };
        if checked_add(header.root.0, header.root.1, "root directory end")? > PROBE {
            return Err("PMTiles root directory is not contained in the first 16 KiB".into());
        }
        let file = bytes.len() as f64;
        add_section(boundaries, (0.0, HEADER_SIZE as f64), file, "header")?;
        add_section(boundaries, header.root, file, "root directory")?;
        add_section(boundaries, header.metadata, file, "metadata")?;
        add_section(boundaries, header.leaves, file, "leaf directories")?;
        add_section(boundaries, header.tiles, file, "tile data")?;
        Ok(header)
    }
}

/// Number.isSafeInteger.
pub fn is_safe(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= MAX_SAFE
}

/// tools/pack.ts checkedAdd: both terms and the sum safe and non-negative.
pub fn checked_add(a: f64, b: f64, name: &str) -> Result<u64> {
    let sum = a + b;
    if !is_safe(a) || !is_safe(b) || !is_safe(sum) || a < 0.0 || b < 0.0 {
        return Err(format!("bad PMTiles arithmetic for {name}").into());
    }
    Ok(sum as u64)
}

/// tools/pack.ts addSection: the section lies inside the file; its start
/// and end become cut boundaries. Returns its byte range.
pub fn add_section(
    boundaries: &mut Vec<u64>,
    (offset, length): Section,
    file: f64,
    name: &str,
) -> Result<Range<usize>> {
    let inside = is_safe(offset) && is_safe(length) && offset >= 0.0 && length >= 0.0;
    if !inside || offset > file || length > file - offset {
        return Err(format!("PMTiles {name} lies outside archive").into());
    }
    let (start, end) = (offset as u64, (offset + length) as u64);
    boundaries.extend([start, end]);
    Ok(start as usize..end as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn header(fields: [u64; 8], compression: u8, size: usize) -> Vec<u8> {
        let mut bytes = vec![0; size];
        bytes[..8].copy_from_slice(b"PMTiles\x03");
        for (i, value) in fields.iter().enumerate() {
            bytes[8 + 8 * i..16 + 8 * i].copy_from_slice(&value.to_le_bytes());
        }
        bytes[COMPRESSION_AT] = compression;
        bytes
    }

    fn read(bytes: &[u8]) -> Result<Header> {
        Header::read(bytes, &mut Vec::new())
    }

    #[test]
    fn reads_sections_and_boundaries() {
        let bytes = header([127, 10, 137, 2, 139, 0, 139, 61], 2, 200);
        let mut boundaries = Vec::new();
        let read = Header::read(&bytes, &mut boundaries).unwrap();
        assert_eq!((read.root, read.tiles, read.compression), ((127.0, 10.0), (139.0, 61.0), 2));
        assert_eq!(boundaries, [0, 127, 127, 137, 137, 139, 139, 139, 139, 200]);
    }

    #[test]
    fn rejects_bad_headers_in_ts_order() {
        let error = |bytes: &[u8]| read(bytes).unwrap_err().0;
        assert_eq!(error(b"PMTiles\x02"), "not a PMTiles v3 archive");
        assert_eq!(error(b"PMTiles\x03"), "truncated PMTiles header");
        let probe = header([16000, 385, 0, 0, 0, 0, 0, 0], 1, 200);
        assert_eq!(error(&probe), "PMTiles root directory is not contained in the first 16 KiB");
        let unsafe_root = header([1 << 60, 1, 0, 0, 0, 0, 0, 0], 1, 200);
        assert_eq!(error(&unsafe_root), "bad PMTiles arithmetic for root directory end");
        let outside = header([127, 1, 128, 500, 0, 0, 0, 0], 1, 200);
        assert_eq!(error(&outside), "PMTiles metadata lies outside archive");
        let huge_tiles = header([127, 1, 128, 1, 129, 0, 130, u64::MAX], 1, 200);
        assert_eq!(error(&huge_tiles), "PMTiles tile data lies outside archive");
    }

    #[test]
    fn safe_integer_arithmetic() {
        assert!(is_safe(9007199254740991.0) && !is_safe(9007199254740992.0) && !is_safe(0.5) && is_safe(-1.0));
        assert_eq!(checked_add(1.0, 2.0, "x"), Ok(3));
        assert_eq!(checked_add(-1.0, 2.0, "x"), Err(Error("bad PMTiles arithmetic for x".into())));
        assert_eq!(checked_add(MAX_SAFE, 1.0, "x"), Err(Error("bad PMTiles arithmetic for x".into())));
    }
}
