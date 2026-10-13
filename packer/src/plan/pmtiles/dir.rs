// PMTiles directories, decoded exactly as the `pmtiles` JS package does
// (deserializeIndex): values are JS numbers, so they are f64 here too. Its
// varint reader keeps only bit 0 of a 10th byte, treats bytes past the end
// as continuation bytes, and ignores bytes after the last column.
use crate::error::Result;

const VARINT_TOO_LONG: &str = "Expected varint not more than 10 bytes";
const EMPTY_DIRECTORY: &str = "Empty directory is invalid";
// A JS `undefined` byte: no payload bits, and "more bytes follow".
const PAST_END: u8 = 0x80;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    pub tile_id: f64,
    pub run_length: f64,
    pub length: f64,
    /// Relative to its section; -1 when the first entry's stored offset is 0.
    pub offset: f64,
}

/// A decompressed directory's entries; an empty directory is an error.
pub fn decode(bytes: &[u8]) -> Result<Vec<Entry>> {
    let mut reader = Reader { bytes, pos: 0 };
    let count = reader.varint()?;
    // Every entry takes at least one byte in each of the four columns, so
    // the buffer bounds the allocation, never the untrusted count.
    let mut entries = Vec::with_capacity(count.min((bytes.len() / 4) as f64) as usize);
    let mut tile_id = 0.0;
    while (entries.len() as f64) < count {
        tile_id += reader.varint()?;
        entries.push(Entry { tile_id, run_length: 1.0, length: 0.0, offset: 0.0 });
    }
    for entry in entries.iter_mut() {
        entry.run_length = reader.varint()?;
    }
    for entry in entries.iter_mut() {
        entry.length = reader.varint()?;
    }
    for i in 0..entries.len() {
        let stored = reader.varint()?;
        entries[i].offset = match i {
            1.. if stored == 0.0 => entries[i - 1].offset + entries[i - 1].length,
            _ => stored - 1.0,
        };
    }
    if entries.is_empty() {
        return Err(EMPTY_DIRECTORY.into());
    }
    Ok(entries)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn peek(&self) -> u8 {
        self.bytes.get(self.pos).copied().unwrap_or(PAST_END)
    }

    fn next(&mut self) -> u8 {
        let byte = self.peek();
        self.pos += 1;
        byte
    }

    // readVarint: four 7-bit groups, then bits 28..31 from a peeked fifth
    // byte that readVarintRemainder reads again for bits 32..34.
    fn varint(&mut self) -> Result<f64> {
        let mut low = 0u32;
        for shift in [0, 7, 14, 21] {
            let byte = self.next();
            low |= u32::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(f64::from(low));
            }
        }
        low |= u32::from(self.peek() & 0x0f) << 28;
        self.remainder(low)
    }

    fn remainder(&mut self, low: u32) -> Result<f64> {
        let to_number = |high: u32| f64::from(high) * 4294967296.0 + f64::from(low);
        let byte = self.next();
        let mut high = u32::from((byte & 0x70) >> 4);
        if byte < 0x80 {
            return Ok(to_number(high));
        }
        for (shift, mask) in [(3, 0x7f), (10, 0x7f), (17, 0x7f), (24, 0x7f), (31, 0x01)] {
            let byte = self.next();
            high |= u32::from(byte & mask) << shift;
            if byte < 0x80 {
                return Ok(to_number(high));
            }
        }
        Err(VARINT_TOO_LONG.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn varint(bytes: &[u8]) -> Result<f64> {
        Reader { bytes, pos: 0 }.varint()
    }

    #[test]
    fn varints_read_like_the_js_reader() {
        assert_eq!(varint(&[0x05]), Ok(5.0));
        assert_eq!(varint(&[0xac, 0x02]), Ok(300.0));
        assert_eq!(varint(&[0x80, 0x80, 0x80, 0x80, 0x10]), Ok(4294967296.0));
        assert_eq!(varint(&[0xff, 0xff, 0xff, 0xff, 0x0f]), Ok(4294967295.0));
        let max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        assert_eq!(varint(&max), Ok(18446744073709551615.0));
        // The 10th byte keeps only bit 0.
        let junk = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7e];
        assert_eq!(varint(&junk), Ok(0.0));
        assert_eq!(varint(&[0x80; 11]), Err(Error(VARINT_TOO_LONG.into())));
        assert_eq!(varint(&[0x81]), Err(Error(VARINT_TOO_LONG.into())));
        assert_eq!(varint(&[]), Err(Error(VARINT_TOO_LONG.into())));
    }

    #[test]
    fn decodes_columns_and_implicit_offsets() {
        // ids 3, 4; runs 1, 2; lengths 10, 20; offsets: stored 6 → 5, then implicit.
        let entries = decode(&[2, 3, 1, 1, 2, 10, 20, 6, 0, 99]).unwrap();
        let entry = |tile_id, run_length, length, offset| Entry { tile_id, run_length, length, offset };
        assert_eq!(entries, [entry(3.0, 1.0, 10.0, 5.0), entry(4.0, 2.0, 20.0, 15.0)]);
        // A stored 0 first offset is -1, and the next implicit offset builds on it.
        let minus = decode(&[2, 0, 1, 1, 1, 5, 5, 0, 0]).unwrap();
        assert_eq!((minus[0].offset, minus[1].offset), (-1.0, 4.0));
    }

    #[test]
    fn rejects_empty_and_truncated_directories() {
        assert_eq!(decode(&[0]), Err(Error(EMPTY_DIRECTORY.into())));
        assert_eq!(decode(&[]), Err(Error(VARINT_TOO_LONG.into())));
        assert_eq!(decode(&[2, 0, 1, 1, 1]), Err(Error(VARINT_TOO_LONG.into())));
        // A huge count fails on the bytes, never on an allocation.
        assert_eq!(decode(&[0xff, 0xff, 0xff, 0xff, 0x0f, 1]), Err(Error(VARINT_TOO_LONG.into())));
    }
}
