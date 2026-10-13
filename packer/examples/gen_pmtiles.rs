// Dev-only: writes a large synthetic PMTiles v3 archive for benchmarks.
//
//   cargo run --release --example gen_pmtiles -- <out.pmtiles> <entries> [entries-per-leaf] [max-tile-bytes]
//
// Gzip leaf directories, increasing tile ids with gaps, run lengths, implicit
// offsets for consecutive tiles, and back-references (entries reusing an
// earlier tile's bytes, as deduplicated ocean tiles do). Tiles are 1 to
// max-tile-bytes (default 16) long, cut from a pseudo-random pool: small
// tiles fit hundreds of millions of entries in a few GB, larger ones give
// realistic archive sizes. Layout: header, root (inside the first 16 KiB),
// metadata at 16 KiB, leaf directories, tile data. The archive is streamed
// in two passes over the same deterministic entries: the first writes the
// leaf directories, whose size sets the tile data offset, and the second
// the tile data.
use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};

use flate2::Compression;
use flate2::write::GzEncoder;
use veritiles_pack::codec::varint::push_varint;
use veritiles_pack::plan::pmtiles::decompress::GZIP;

const HEADER_SIZE: u64 = 127;
const METADATA_OFFSET: u64 = 16 * 1024;
const METADATA: &[u8] = b"{\"name\":\"synthetic\"}";

struct Entry {
    tile_id: u64,
    run_length: u64,
    length: u64,
    offset: u64,
}

// Deterministic per-entry choices.
fn mix(i: u64) -> u64 {
    let mut x = i.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    x ^= x >> 29;
    x.wrapping_mul(0xbf58_476d_1ce4_e5b9) >> 32
}

const RECENT: usize = 1024;
const POOL: usize = 1 << 20;

struct Generator<'a, W: Write> {
    next_id: u64,
    tile_data_len: u64,
    tiles: W,
    max_len: u64,
    pool: &'a [u8],
    /// Recently written tiles `(offset, length)`, for back-references.
    recent: Vec<(u64, u64)>,
}

impl<'a, W: Write> Generator<'a, W> {
    fn new(tiles: W, max_len: u64, pool: &'a [u8]) -> Self {
        Generator { next_id: 0, tile_data_len: 0, tiles, max_len, pool, recent: Vec::new() }
    }

    fn entry(&mut self, i: u64) -> io::Result<Entry> {
        let bits = mix(i);
        let tile_id = self.next_id + bits % 3;
        let run_length = if bits.is_multiple_of(10) { 2 + bits % 4 } else { 1 };
        self.next_id = tile_id + run_length;
        // About every 7th entry reuses the bytes of a recent tile.
        if bits.is_multiple_of(7) && !self.recent.is_empty() {
            let (offset, length) = self.recent[(bits >> 8) as usize % self.recent.len()];
            return Ok(Entry { tile_id, run_length, length, offset });
        }
        let length = 1 + bits % self.max_len;
        let offset = self.tile_data_len;
        let start = (bits >> 16) as usize % (POOL - length as usize + 1);
        self.tiles.write_all(&self.pool[start..start + length as usize])?;
        self.tile_data_len += length;
        if self.recent.len() < RECENT {
            self.recent.push((offset, length));
        } else {
            self.recent[(i % RECENT as u64) as usize] = (offset, length);
        }
        Ok(Entry { tile_id, run_length, length, offset })
    }
}

// Offsets are stored +1, or 0 when the entry directly follows the previous.
fn directory(entries: &[Entry]) -> io::Result<Vec<u8>> {
    let mut raw = Vec::with_capacity(entries.len() * 6);
    push_varint(&mut raw, entries.len() as u64);
    let mut last_id = 0;
    for entry in entries {
        push_varint(&mut raw, entry.tile_id - last_id);
        last_id = entry.tile_id;
    }
    entries.iter().for_each(|e| push_varint(&mut raw, e.run_length));
    entries.iter().for_each(|e| push_varint(&mut raw, e.length));
    for (i, entry) in entries.iter().enumerate() {
        let follows = i > 0 && entries[i - 1].offset + entries[i - 1].length == entry.offset;
        push_varint(&mut raw, if follows { 0 } else { entry.offset + 1 });
    }
    gzip(&raw)
}

fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes)?;
    encoder.finish()
}

fn header(sections: [(u64, u64); 4], entries: u64) -> Vec<u8> {
    let mut bytes = b"PMTiles\x03".to_vec();
    for (offset, length) in sections {
        bytes.extend(offset.to_le_bytes());
        bytes.extend(length.to_le_bytes());
    }
    for _ in 0..3 {
        bytes.extend(entries.to_le_bytes());
    }
    bytes.extend([1, GZIP, 1, 1, 0, 15]);
    bytes.resize(HEADER_SIZE as usize, 0);
    bytes
}

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [out, entries, rest @ ..] = &args[..] else {
        eprintln!("usage: gen_pmtiles <out.pmtiles> <entries> [entries-per-leaf] [max-tile-bytes]");
        std::process::exit(2);
    };
    let entries: u64 = entries.parse().expect("entries");
    let per_leaf: u64 = rest.first().map_or(65536, |n| n.parse().expect("entries-per-leaf"));
    let max_len: u64 = rest.get(1).map_or(16, |n| n.parse().expect("max-tile-bytes"));
    assert!((1..=POOL as u64).contains(&max_len), "max-tile-bytes must be 1..={POOL}");
    let pool: Vec<u8> = (0..POOL as u64 / 8).flat_map(|i| mix(i ^ 0x5eed).to_le_bytes()).collect();
    let mut file = BufWriter::new(File::create(out)?);
    let metadata = gzip(METADATA)?;
    let leaf_start = METADATA_OFFSET + metadata.len() as u64;
    file.seek(SeekFrom::Start(METADATA_OFFSET))?;
    file.write_all(&metadata)?;
    let mut generator = Generator::new(io::sink(), max_len, &pool);
    let (mut root, mut leaf_len, mut done) = (Vec::new(), 0u64, 0u64);
    while done < entries {
        let count = per_leaf.min(entries - done);
        let leaf: Vec<Entry> = (done..done + count).map(|i| generator.entry(i)).collect::<io::Result<_>>()?;
        let stored = directory(&leaf)?;
        root.push(Entry { tile_id: leaf[0].tile_id, run_length: 0, length: stored.len() as u64, offset: leaf_len });
        file.write_all(&stored)?;
        leaf_len += stored.len() as u64;
        done += count;
    }
    let tile_data_len = generator.tile_data_len;
    let root_bytes = directory(&root)?;
    assert!(HEADER_SIZE + root_bytes.len() as u64 <= METADATA_OFFSET, "root over 16 KiB: raise entries-per-leaf");
    let tile_offset = leaf_start + leaf_len;
    let mut generator = Generator::new(&mut file, max_len, &pool);
    for i in 0..entries {
        generator.entry(i)?;
    }
    let sections = [
        (HEADER_SIZE, root_bytes.len() as u64),
        (METADATA_OFFSET, metadata.len() as u64),
        (leaf_start, leaf_len),
        (tile_offset, tile_data_len),
    ];
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&[header(sections, entries), root_bytes].concat())?;
    file.flush()?;
    eprintln!("{entries} entries in {} leaves, {tile_data_len} B tile data, file {out}", root.len());
    Ok(())
}
