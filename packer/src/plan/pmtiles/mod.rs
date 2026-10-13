// PMTiles v3 parsing, check for check as tools/pack.ts parsePmtiles: header
// and sections, the root directory, each distinct leaf directory in root
// order, every tile entry, then the metadata. Errors keep the TS order:
// directory errors (in root order) before tile-entry errors, and those
// before metadata errors. Leaf directories decode in parallel batches, each
// while the previous one is added.
pub mod decompress;
pub mod dir;
pub mod header;
pub mod json;
pub mod ranges;

use std::collections::HashSet;
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::error::{Error, Result};
use decompress::decompress;
use dir::Entry;
use header::{Header, add_section, checked_add};
use ranges::{MAX_TILE_ENTRIES, Tile, TileCheck, Tiles};

pub use header::is_pmtiles_v3;

// A batch of leaf directories decodes in parallel. Batches are sized by
// stored bytes, which do not bound the decoded size: that is bounded by the
// 256 MiB cap per directory and by the entry cap, past which decoded units
// keep only their entry counts.
const BATCH_DIRS: usize = 1024;
const BATCH_BYTES: usize = 64 << 20;
const TOO_MANY_ENTRIES: &str = "PMTiles has more than 2^30 tile entries";

pub struct Parsed {
    pub tile_data: Range<u64>,
    /// Section boundaries (header, root, metadata, leaf directories, tile
    /// data, each leaf directory), sorted and distinct.
    pub boundaries: Vec<u64>,
    /// Unique tile ranges sorted by offset.
    pub tiles: Tiles,
}

pub fn parse(bytes: &[u8]) -> Result<Parsed> {
    parse_with_max_entries(bytes, MAX_TILE_ENTRIES)
}

/// `parse` with another tile-entry cap.
pub fn parse_with_max_entries(bytes: &[u8], max_entries: u64) -> Result<Parsed> {
    let mut boundaries = Vec::new();
    let header = Header::read(bytes, &mut boundaries)?;
    let root_range = header.root.0 as usize..(header.root.0 + header.root.1) as usize;
    let root = decode_directory(&bytes[root_range], header.compression)?;
    let tiles = Walk::new(bytes, &header, &mut boundaries, max_entries)?.run(&root)?;
    let metadata_end = checked_add(header.metadata.0, header.metadata.1, "metadata end")?;
    json::check_metadata(&decompress(&bytes[header.metadata.0 as usize..metadata_end as usize], header.compression)?)?;
    boundaries.sort_unstable();
    boundaries.dedup();
    let (offset, length) = header.tiles;
    Ok(Parsed { tile_data: offset as u64..(offset + length) as u64, boundaries, tiles })
}

fn decode_directory(stored: &[u8], compression: u8) -> Result<Vec<Entry>> {
    dir::decode(&decompress(stored, compression)?)
}

// A root entry in reference order: a tile, or a distinct leaf directory.
enum Unit {
    Tile(Entry),
    Leaf(Range<usize>),
}

// The root loop of parsePmtiles.
struct Walk<'a> {
    bytes: &'a [u8],
    header: &'a Header,
    boundaries: &'a mut Vec<u64>,
    check: TileCheck,
    seen: HashSet<(u64, u64)>,
    batch: Vec<Unit>,
    batch_bytes: usize,
    // The previous batch, decoded, waiting to be added.
    decoded: Vec<Checked>,
    added: Added,
    budget: Budget,
}

// A unit's entry count and tiles: the outer error is a decoding error, the
// inner one the first failed tile check.
type Checked = Result<(u64, Result<Vec<Tile>>)>;

// Entries decoded so far, in any order. Once past the cap the result is a
// directory error or the cap error, whichever comes first in root order, so
// tiles no longer matter.
struct Budget {
    decoded: AtomicU64,
    max_entries: u64,
}

impl Budget {
    // Counts `entries`; false once the decoded total is over the cap.
    fn keep(&self, entries: u64) -> bool {
        self.decoded.fetch_add(entries, Ordering::Relaxed) + entries <= self.max_entries
    }
}

// Decoded units added in root order. Too many entries is an error at once,
// like a directory error. After the first failed check the tiles no longer
// matter: that error is the result, unless a directory fails to decode or
// the entries overflow first.
struct Added {
    tiles: Tiles,
    entries: u64,
    max_entries: u64,
    first_error: Option<Error>,
}

impl Added {
    fn add(&mut self, decoded: Vec<Checked>) -> Result<()> {
        for checked in decoded {
            let (entries, tiles) = checked?;
            self.entries += entries;
            if self.entries > self.max_entries {
                return Err(TOO_MANY_ENTRIES.into());
            }
            match tiles {
                Ok(tiles) if self.first_error.is_none() => self.tiles.extend(tiles),
                Ok(_) => {}
                Err(err) => _ = self.first_error.get_or_insert(err),
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<Tiles> {
        match self.first_error {
            Some(err) => Err(err),
            None => Ok(self.tiles.finish()),
        }
    }
}

impl<'a> Walk<'a> {
    fn new(bytes: &'a [u8], header: &'a Header, boundaries: &'a mut Vec<u64>, max_entries: u64) -> Result<Walk<'a>> {
        let check = TileCheck::new(header)?;
        let (seen, batch, decoded) = (HashSet::new(), Vec::new(), Vec::new());
        let added = Added { tiles: Tiles::default(), entries: 0, max_entries, first_error: None };
        let budget = Budget { decoded: AtomicU64::new(0), max_entries };
        Ok(Walk { bytes, header, boundaries, check, seen, batch, batch_bytes: 0, decoded, added, budget })
    }

    fn run(mut self, root: &[Entry]) -> Result<Tiles> {
        for entry in root {
            if entry.run_length != 0.0 {
                self.batch.push(Unit::Tile(*entry));
                continue;
            }
            match self.leaf_range(entry) {
                Ok(Some(range)) => self.push_leaf(range)?,
                Ok(None) => {}
                Err(err) => {
                    // Directories before this pointer decode (and fail) first.
                    self.drain()?;
                    return Err(err);
                }
            }
        }
        self.drain()?;
        self.added.finish()
    }

    // The leaf directory a root entry points at; None when already seen.
    fn leaf_range(&mut self, entry: &Entry) -> Result<Option<Range<usize>>> {
        let offset = checked_add(self.header.leaves.0, entry.offset, "leaf directory offset")?;
        if !self.seen.insert((offset, entry.length.to_bits())) {
            return Ok(None);
        }
        let file = self.bytes.len() as f64;
        add_section(self.boundaries, (offset as f64, entry.length), file, "leaf directory").map(Some)
    }

    fn push_leaf(&mut self, range: Range<usize>) -> Result<()> {
        self.batch_bytes += range.len();
        self.batch.push(Unit::Leaf(range));
        if self.batch.len() >= BATCH_DIRS || self.batch_bytes >= BATCH_BYTES {
            self.flush()?;
        }
        Ok(())
    }

    // Decodes the batch while the previous one is added: adding is
    // sequential, and would otherwise leave the decoders idle.
    fn flush(&mut self) -> Result<()> {
        let (bytes, check, compression) = (self.bytes, self.check, self.header.compression);
        let batch = std::mem::take(&mut self.batch);
        let previous = std::mem::take(&mut self.decoded);
        let (added, budget) = (&mut self.added, &self.budget);
        let (result, decoded) =
            rayon::join(|| added.add(previous), || decode_batch(bytes, batch, compression, &check, budget));
        result?;
        self.decoded = decoded;
        self.batch_bytes = 0;
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        self.flush()?;
        self.added.add(std::mem::take(&mut self.decoded))
    }
}

fn decode_batch(bytes: &[u8], batch: Vec<Unit>, compression: u8, check: &TileCheck, budget: &Budget) -> Vec<Checked> {
    let decode = |unit| match unit {
        Unit::Tile(entry) if budget.keep(1) => Ok((1, check.tile(&entry).map(|tile| vec![tile]))),
        Unit::Tile(_) => Ok((1, Ok(Vec::new()))),
        Unit::Leaf(range) => leaf_tiles(&bytes[range], compression, check, budget),
    };
    batch.into_par_iter().map(decode).collect()
}

fn leaf_tiles(stored: &[u8], compression: u8, check: &TileCheck, budget: &Budget) -> Checked {
    let entries = decode_directory(stored, compression)?;
    let count = entries.len() as u64;
    if !budget.keep(count) {
        return Ok((count, Ok(Vec::new())));
    }
    Ok((count, check_all(&entries, check)))
}

// The first failed check is the error.
fn check_all(entries: &[Entry], check: &TileCheck) -> Result<Vec<Tile>> {
    let mut tiles = Vec::with_capacity(entries.len());
    for entry in entries {
        tiles.push(check.tile(entry)?);
    }
    Ok(tiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(max_entries: u64) -> Added {
        Added { tiles: Tiles::default(), entries: 0, max_entries, first_error: None }
    }

    fn failed(message: &str) -> Checked {
        Ok((1, Err(message.into())))
    }

    #[test]
    fn the_first_failed_check_wins() {
        let mut added = added(MAX_TILE_ENTRIES);
        let tile = Tile { offset: 0, length: 1, zoom: 0 };
        added.add(vec![Ok((1, Ok(vec![tile]))), failed("first"), failed("second")]).unwrap();
        assert_eq!(added.finish().unwrap_err().0, "first");
    }

    #[test]
    fn too_many_entries_beats_a_failed_check() {
        let mut added = added(3);
        added.add(vec![failed("check"), Ok((2, Ok(Vec::new())))]).unwrap();
        assert_eq!(added.add(vec![Ok((1, Ok(Vec::new())))]).unwrap_err().0, TOO_MANY_ENTRIES);
    }
}
