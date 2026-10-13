// Leaf partitions of the input: the byte ranges each proof leaf covers.
pub mod cuts;
pub mod mp4;
pub mod pmtiles;

/// Leaves in file order. `Fixed` is computed, never stored, so a planet-sized
/// input with tiny chunks costs no memory per leaf.
#[derive(Debug, Clone)]
pub enum Leaves {
    /// `chunk`-byte leaves, the last one shorter; an empty input is one
    /// empty leaf, as the TS chunker yields.
    Fixed { chunk: u64, size: u64 },
    /// Explicit `(offset, length)` spans, offsets ascending.
    Spans(Vec<(u64, u64)>),
}

impl Leaves {
    pub fn count(&self) -> u64 {
        match self {
            Leaves::Fixed { size: 0, .. } => 1,
            Leaves::Fixed { chunk, size } => size.div_ceil(*chunk),
            Leaves::Spans(spans) => spans.len() as u64,
        }
    }

    /// `(offset, length)` of leaf `index`.
    pub fn span(&self, index: u64) -> (u64, u64) {
        match self {
            Leaves::Fixed { chunk, size } => {
                let offset = index * chunk;
                (offset, (*chunk).min(size - offset))
            }
            Leaves::Spans(spans) => spans[index as usize],
        }
    }
}
