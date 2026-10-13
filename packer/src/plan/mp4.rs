// Fragmented MP4 leaves, check for check as tools/pack.ts isFragmentedMp4
// and mp4Cuts: a walk over the top-level ISO BMFF boxes. The init section
// is one leaf, each fragment ([styp/emsg/prft…] moof mdat [mdat…]) one, and
// the boxes after the last mdat (an mfra) a tail leaf, so a player that
// reads a fragment at the range its sidx lists reads exactly one leaf.
use crate::error::Result;

// Boxes that open a media segment ahead of its moof; they travel with it.
const SEGMENT_BOXES: [[u8; 4]; 3] = [*b"styp", *b"emsg", *b"prft"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Mp4Box {
    offset: u64,
    size: u64,
    kind: [u8; 4],
}

/// Whether `--profile auto` packs these bytes as fragmented MP4: an `ftyp`
/// box first, then a top-level `moof` before the walk ends. A malformed box
/// before that only means "not fragmented MP4"; after it, packing fails.
pub fn is_fragmented_mp4(bytes: &[u8]) -> bool {
    for next in boxes(bytes) {
        let Ok(found) = next else { return false };
        if found.offset == 0 && &found.kind != b"ftyp" {
            return false;
        }
        if &found.kind == b"moof" {
            return true;
        }
    }
    false
}

/// The mp4 profile's leaf `(offset, length)` spans. A malformed box, or no
/// `moof` at all, is an error.
pub fn leaf_spans(bytes: &[u8]) -> Result<Vec<(u64, u64)>> {
    let mut cuts = Cuts::default();
    for next in boxes(bytes) {
        cuts.add(next?);
    }
    if !cuts.fragmented {
        return Err("not a fragmented MP4: no moof box".into());
    }
    Ok(cuts.spans(bytes.len() as u64))
}

// Cut points as the boxes are walked: where the first fragment starts, then
// every box that follows an mdat and is not one.
#[derive(Default)]
struct Cuts {
    points: Vec<u64>,
    fragmented: bool,
    // Where the run of segment boxes just before the current box began.
    segment_start: Option<u64>,
    previous: [u8; 4],
}

impl Cuts {
    fn add(&mut self, found: Mp4Box) {
        if !self.fragmented && &found.kind == b"moof" {
            self.fragmented = true;
            self.points.push(self.segment_start.unwrap_or(found.offset));
        } else if self.fragmented && &self.previous == b"mdat" && &found.kind != b"mdat" {
            self.points.push(found.offset);
        }
        let segment = SEGMENT_BOXES.contains(&found.kind);
        self.segment_start = if segment { self.segment_start.or(Some(found.offset)) } else { None };
        self.previous = found.kind;
    }

    // Spans between 0, the cut points and the end of the file. A first
    // fragment at offset 0 leaves no init leaf.
    fn spans(&self, end: u64) -> Vec<(u64, u64)> {
        let points: Vec<u64> = [0].into_iter().chain(self.points.iter().copied()).chain([end]).collect();
        points.windows(2).filter(|pair| pair[1] > pair[0]).map(|pair| (pair[0], pair[1] - pair[0])).collect()
    }
}

// Top-level boxes in file order; a malformed box ends the walk with its error.
fn boxes(bytes: &[u8]) -> impl Iterator<Item = Result<Mp4Box>> + '_ {
    let mut offset = 0;
    std::iter::from_fn(move || {
        if offset == bytes.len() {
            return None;
        }
        let next = read_box(bytes, offset);
        offset = next.as_ref().map_or(bytes.len(), |found| offset + found.size as usize);
        Some(next)
    })
}

// The box at `offset` (ISO/IEC 14496-12 §4.2): a 32-bit size; or 1 and a
// 64-bit size after the type; or 0 for a box that runs to the end of the
// file.
fn read_box(bytes: &[u8], offset: usize) -> Result<Mp4Box> {
    let at = &bytes[offset..];
    let remaining = at.len() as u64;
    let fail = |problem: &str| Err(format!("MP4 box at {offset} {problem}").into());
    if remaining < 8 {
        return fail("has a truncated header");
    }
    let (size, min) = match u32::from_be_bytes(at[..4].try_into().unwrap()) {
        1 if remaining < 16 => return fail("has a truncated header"),
        1 => (u64::from_be_bytes(at[8..16].try_into().unwrap()), 16),
        0 => (remaining, 8),
        size => (u64::from(size), 8),
    };
    if size < min {
        return fail("has an invalid size");
    }
    if size > remaining {
        return fail("extends past the end of the file");
    }
    Ok(Mp4Box { offset: offset as u64, size, kind: at[4..8].try_into().unwrap() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn header(size: u32, kind: &[u8; 4]) -> Vec<u8> {
        [&size.to_be_bytes(), kind.as_slice()].concat()
    }

    #[test]
    fn reads_each_size_form() {
        let large = [header(1, b"mdat"), 20u64.to_be_bytes().to_vec(), vec![0; 4]].concat();
        assert_eq!(read_box(&large, 0), Ok(Mp4Box { offset: 0, size: 20, kind: *b"mdat" }));
        let open = [header(0, b"mdat"), vec![0; 5]].concat();
        assert_eq!(read_box(&open, 0).map(|found| found.size), Ok(13));
        let shifted = [vec![9; 3], header(8, b"free")].concat();
        assert_eq!(read_box(&shifted, 3), Ok(Mp4Box { offset: 3, size: 8, kind: *b"free" }));
    }

    #[test]
    fn the_walk_stops_at_the_first_malformed_box() {
        let bytes = [header(8, b"ftyp"), header(3, b"moov"), header(8, b"moof")].concat();
        let walked: Vec<_> = boxes(&bytes).collect();
        assert_eq!(walked.len(), 2);
        assert_eq!(walked[1], Err(Error("MP4 box at 8 has an invalid size".into())));
        assert!(!is_fragmented_mp4(&bytes));
    }

    #[test]
    fn detection_stops_at_the_first_moof() {
        // A malformed box after the first moof is the pack's error, not detection's.
        let bytes = [header(8, b"ftyp"), header(8, b"moof"), header(8, b"mdat"), header(99, b"mfra")].concat();
        assert!(is_fragmented_mp4(&bytes));
        assert_eq!(leaf_spans(&bytes), Err(Error("MP4 box at 24 extends past the end of the file".into())));
    }
}
