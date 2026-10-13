// Tile byte ranges: the per-entry checks of tools/pack.ts parsePmtiles, then
// uniqueRanges (first occurrence wins) and the offset-stable sort, then
// groupedTileRanges. Built for 100M+ entries: 16-byte records plus one zoom
// byte per entry, sorted in parallel.
use rayon::prelude::*;

use super::dir::Entry;
use super::header::{Header, checked_add, is_safe};
use crate::error::Result;

const MAX_TILE_LENGTH: f64 = 4294967295.0;
/// Tile entries an archive may have, counting duplicates (tools/pack.ts).
pub const MAX_TILE_ENTRIES: u64 = 1 << 30;

/// A checked tile entry: absolute offset, length, and zoom level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    pub offset: u64,
    pub length: u32,
    pub zoom: u8,
}

/// A tile range; `seq` is its entry's position in reference (TS) order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record {
    pub offset: u64,
    pub length: u32,
    pub seq: u32,
}

impl Record {
    pub fn end(&self) -> u64 {
        self.offset + u64::from(self.length)
    }
}

/// The tile-entry checks, in the TS order.
#[derive(Debug, Clone, Copy)]
pub struct TileCheck {
    tile_data_offset: f64,
    tile_data_end: u64,
}

impl TileCheck {
    /// For a header whose sections already passed `Header::read`.
    pub fn new(header: &Header) -> Result<TileCheck> {
        let (offset, length) = header.tiles;
        Ok(TileCheck { tile_data_offset: offset, tile_data_end: checked_add(offset, length, "tile data end")? })
    }

    pub fn tile(&self, entry: &Entry) -> Result<Tile> {
        if entry.run_length <= 0.0 {
            return Err("invalid PMTiles tile run length".into());
        }
        if !is_safe(entry.tile_id) {
            return Err("PMTiles tile id is not a safe integer".into());
        }
        if entry.length > MAX_TILE_LENGTH {
            return Err("PMTiles tile length exceeds 0xffffffff".into());
        }
        let offset = checked_add(self.tile_data_offset, entry.offset, "tile offset")?;
        let end = checked_add(offset as f64, entry.length, "tile end")?;
        if end > self.tile_data_end {
            return Err("PMTiles tile lies outside tile data".into());
        }
        Ok(Tile { offset, length: entry.length as u32, zoom: zoom_of(entry.tile_id as u64) })
    }
}

/// The zoom of a Hilbert tile id: zoom z covers [(4^z − 1)/3, (4^(z+1) − 1)/3).
/// So 4^z ≤ 3·id + 1 < 4^(z+1), and z is half the bit length of 3·id + 1
/// (no overflow: ids are safe integers, below 2^53).
pub fn zoom_of(tile_id: u64) -> u8 {
    ((3 * tile_id + 1).ilog2() / 2) as u8
}

/// Tile ranges in reference order, then (after `finish`) unique and sorted.
#[derive(Debug, Default)]
pub struct Tiles {
    pub records: Vec<Record>,
    /// Indexed by `Record::seq`.
    pub zooms: Vec<u8>,
}

impl Tiles {
    /// Appends tiles in reference order. Callers keep the total within
    /// `MAX_TILE_ENTRIES`, so `seq` fits u32.
    pub fn extend(&mut self, tiles: impl IntoIterator<Item = Tile>) {
        for tile in tiles {
            let seq = self.zooms.len() as u32;
            self.records.push(Record { offset: tile.offset, length: tile.length, seq });
            self.zooms.push(tile.zoom);
        }
    }

    /// Keeps each (offset, length) once, first entry winning, ordered by
    /// offset and then by entry order: TS uniqueRanges + a stable sort.
    pub fn finish(mut self) -> Tiles {
        self.records.par_sort_unstable_by_key(|r| (r.offset, r.length, r.seq));
        self.records.dedup_by_key(|r| (r.offset, r.length));
        for same_offset in self.records.chunk_by_mut(|a, b| a.offset == b.offset) {
            same_offset.sort_unstable_by_key(|r| r.seq);
        }
        self
    }
}

/// Contiguous tiles merged up to `budget` bytes (TS groupedTileRanges),
/// stored as the index of each group's first record.
pub struct Groups<'a> {
    tiles: &'a Tiles,
    starts: Vec<u32>,
}

impl<'a> Groups<'a> {
    pub fn new(tiles: &'a Tiles, budget: u64) -> Groups<'a> {
        let mut starts = Vec::new();
        let (mut length, mut end) = (0u64, 0u64);
        for (i, record) in tiles.records.iter().enumerate() {
            let joins = !starts.is_empty() && record.offset == end && budget != 0;
            if joins && length + u64::from(record.length) <= budget {
                length += u64::from(record.length);
                end += u64::from(record.length);
                continue;
            }
            starts.push(i as u32);
            (length, end) = (u64::from(record.length), record.end());
        }
        Groups { tiles, starts }
    }

    pub fn len(&self) -> usize {
        self.starts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.starts.is_empty()
    }

    pub fn start(&self, group: usize) -> u64 {
        self.tiles.records[self.starts[group] as usize].offset
    }

    // Grouped tiles are contiguous, so the group ends where its last tile does.
    pub fn end(&self, group: usize) -> u64 {
        let next = self.starts.get(group + 1).map_or(self.tiles.records.len(), |&i| i as usize);
        self.tiles.records[next - 1].end()
    }

    pub fn zoom(&self, group: usize) -> u8 {
        self.tiles.zooms[self.tiles.records[self.starts[group] as usize].seq as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiles(ranges: &[(u64, u32, u8)]) -> Tiles {
        let mut tiles = Tiles::default();
        tiles.extend(ranges.iter().map(|&(offset, length, zoom)| Tile { offset, length, zoom }));
        tiles.finish()
    }

    fn spans(groups: &Groups) -> Vec<(u64, u64, u8)> {
        (0..groups.len()).map(|g| (groups.start(g), groups.end(g), groups.zoom(g))).collect()
    }

    #[test]
    fn zoom_boundaries() {
        let zooms: Vec<u8> = [0, 1, 4, 5, 20, 21, 6004799503160660, 6004799503160661, 9007199254740991]
            .into_iter()
            .map(zoom_of)
            .collect();
        assert_eq!(zooms, [0, 1, 1, 2, 2, 3, 26, 27, 27]);
    }

    #[test]
    fn unique_ranges_keep_first_entry_and_entry_order() {
        let sorted = tiles(&[(10, 5, 1), (0, 5, 2), (10, 5, 3), (10, 2, 4), (0, 5, 5)]);
        let order: Vec<(u64, u32, u32)> = sorted.records.iter().map(|r| (r.offset, r.length, r.seq)).collect();
        assert_eq!(order, [(0, 5, 1), (10, 5, 0), (10, 2, 3)]);
    }

    #[test]
    fn groups_merge_contiguous_tiles_under_the_budget() {
        let sorted = tiles(&[(0, 4, 1), (4, 4, 2), (8, 4, 3), (20, 1, 4), (21, 0, 5)]);
        assert_eq!(spans(&Groups::new(&sorted, 8)), [(0, 8, 1), (8, 12, 3), (20, 21, 4)]);
        assert_eq!(spans(&Groups::new(&sorted, 0)).len(), 5);
        assert_eq!(spans(&Groups::new(&sorted, 1 << 20)), [(0, 12, 1), (20, 21, 4)]);
        // A duplicate offset with another length never joins the group before it.
        let dup = tiles(&[(0, 5, 1), (0, 3, 2), (3, 2, 3)]);
        assert_eq!(spans(&Groups::new(&dup, 100)), [(0, 5, 1), (0, 5, 2)]);
    }

    #[test]
    fn checks_run_in_ts_order() {
        let header =
            Header { root: (0.0, 0.0), metadata: (0.0, 0.0), leaves: (0.0, 0.0), tiles: (100.0, 50.0), compression: 1 };
        let check = TileCheck::new(&header).unwrap();
        let entry = |tile_id, run_length, length, offset| Entry { tile_id, run_length, length, offset };
        let error = |e: Entry| check.tile(&e).unwrap_err().0;
        assert_eq!(error(entry(9e15, 0.0, 5e9, -1.0)), "invalid PMTiles tile run length");
        assert_eq!(error(entry(9.1e15, 1.0, 5e9, -1.0)), "PMTiles tile id is not a safe integer");
        assert_eq!(error(entry(1.0, 1.0, 5e9, -1.0)), "PMTiles tile length exceeds 0xffffffff");
        assert_eq!(error(entry(1.0, 1.0, 5.0, -1.0)), "bad PMTiles arithmetic for tile offset");
        assert_eq!(error(entry(1.0, 1.0, 100.0, 9007199254740800.0)), "bad PMTiles arithmetic for tile end");
        assert_eq!(error(entry(1.0, 1.0, 51.0, 0.0)), "PMTiles tile lies outside tile data");
        assert_eq!(check.tile(&entry(4.0, 2.0, 50.0, 0.0)), Ok(Tile { offset: 100, length: 50, zoom: 1 }));
    }
}
