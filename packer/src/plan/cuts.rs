// PMTiles leaf cuts and zoom bands (tools/pack.ts pmtilesCutPoints,
// cutLengths, pmtilesBands). Cut points stream out of one min-heap seeded
// with the section boundaries: tile groups arrive by start, and every point
// still to come is at least the current group's start, so whatever the heap
// holds below it is final. The heap holds sections and pending group ends.
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::ops::Range;

use crate::error::Result;
use crate::plan::pmtiles::header::PROBE;
use crate::plan::pmtiles::ranges::Groups;

/// Leaf `(offset, length)` spans between the sorted, distinct cut points:
/// 0, the file end, the 16 KiB probe, section boundaries, group edges.
pub fn leaf_spans(file_len: u64, boundaries: &[u64], groups: &Groups) -> Vec<(u64, u64)> {
    let probe = (file_len > PROBE).then_some(PROBE);
    let seeds = boundaries.iter().copied().chain([0, file_len]).chain(probe);
    let mut heap: BinaryHeap<Reverse<u64>> = seeds.map(Reverse).collect();
    let mut spans = Spans { spans: Vec::new(), last: 0 };
    for group in 0..groups.len() {
        let start = groups.start(group);
        while let Some(&Reverse(point)) = heap.peek().filter(|Reverse(p)| *p < start) {
            spans.cut(point);
            heap.pop();
        }
        heap.extend([Reverse(start), Reverse(groups.end(group))]);
    }
    while let Some(Reverse(point)) = heap.pop() {
        spans.cut(point);
    }
    spans.spans
}

struct Spans {
    spans: Vec<(u64, u64)>,
    last: u64,
}

impl Spans {
    // Points arrive sorted from 0; repeats give empty spans, which are dropped.
    fn cut(&mut self, point: u64) {
        if point > self.last {
            self.spans.push((self.last, point - self.last));
            self.last = point;
        }
    }
}

/// Leaf-index bands: head leaves (before tile data) form one band, then
/// maximal runs of leaves whose covering group has the same zoom, then the
/// sections after the tile data. A leaf inside the tile data must start
/// inside a group.
pub fn bands(spans: &[(u64, u64)], tile_data: Range<u64>, groups: &Groups) -> Result<Vec<Range<u64>>> {
    let mut bands = Vec::new();
    let (mut band_start, mut band_zoom, mut group) = (0, None, 0);
    for (leaf, &(offset, _)) in spans.iter().enumerate() {
        let mut zoom = None;
        if tile_data.contains(&offset) {
            while group < groups.len() && groups.end(group) <= offset {
                group += 1;
            }
            if group == groups.len() || offset < groups.start(group) {
                return Err(format!("tile leaf at {offset} matches no tile group").into());
            }
            zoom = Some(groups.zoom(group));
        }
        if zoom != band_zoom && leaf > band_start {
            bands.push(band_start as u64..leaf as u64);
            band_start = leaf;
        }
        band_zoom = zoom;
    }
    if spans.len() > band_start {
        bands.push(band_start as u64..spans.len() as u64);
    }
    Ok(bands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::plan::pmtiles::ranges::{Tile, Tiles};

    fn tiles(ranges: &[(u64, u32, u8)]) -> Tiles {
        let mut tiles = Tiles::default();
        tiles.extend(ranges.iter().map(|&(offset, length, zoom)| Tile { offset, length, zoom }));
        tiles.finish()
    }

    #[test]
    fn cuts_at_sections_probe_and_group_edges() {
        let overlapping = tiles(&[(20000, 100, 0), (20100, 50, 1), (20000, 300, 2)]);
        let groups = Groups::new(&overlapping, 0);
        let spans = leaf_spans(20400, &[0, 127, 140, 20000, 20400], &groups);
        let points: Vec<u64> = spans.iter().map(|s| s.0).chain([20400]).collect();
        assert_eq!(points, [0, 127, 140, 16384, 20000, 20100, 20150, 20300, 20400]);
        // A small file has no probe cut.
        let empty = Tiles::default();
        assert_eq!(leaf_spans(300, &[0, 127, 300], &Groups::new(&empty, 0)), [(0, 127), (127, 173)]);
    }

    #[test]
    fn bands_follow_the_covering_group() {
        let zoomed = tiles(&[(100, 50, 0), (150, 50, 1), (200, 50, 1), (250, 50, 2)]);
        let groups = Groups::new(&zoomed, 0);
        let spans = [(0, 100), (100, 50), (150, 50), (200, 25), (225, 25), (250, 50)];
        assert_eq!(bands(&spans, 100..300, &groups), Ok(vec![0..1, 1..2, 2..5, 5..6]));
        let gappy = tiles(&[(100, 50, 0), (150, 10, 0)]);
        let gap = [(0, 100), (100, 50), (150, 10), (160, 140)];
        let error = Error("tile leaf at 160 matches no tile group".into());
        assert_eq!(bands(&gap, 100..300, &Groups::new(&gappy, 0)), Err(error));
    }

    #[test]
    fn sections_after_the_tile_data_form_their_own_band() {
        let zoomed = tiles(&[(100, 50, 0), (150, 50, 1)]);
        let spans = [(0, 100), (100, 50), (150, 50), (200, 30), (230, 70)];
        assert_eq!(bands(&spans, 100..200, &Groups::new(&zoomed, 0)), Ok(vec![0..1, 1..2, 2..3, 3..5]));
    }
}
