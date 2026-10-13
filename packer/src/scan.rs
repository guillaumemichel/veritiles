// One pass over the input, shared by pack and verify. A hasher thread
// streams the whole file through BLAKE3 (the raw map CID) while the caller
// hashes pieces of it in parallel
// straight from the map, a step at a time, staying at most AHEAD bytes in
// front so each page is read from disk once even when the file is larger
// than RAM; each step asks the disk for the next one ahead of time.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use crate::codec::Digest;
use crate::error::Result;
use crate::input::Input;

/// Bytes a step spans at most, unless one item alone is larger.
pub const STEP_BYTES: u64 = 256 << 20;
const HASHER_SLICE: usize = 64 << 20;
const AHEAD: u64 = 1 << 30;
// Bytes past a step read ahead while it hashes; a step's worth measured best.
const PREFETCH: u64 = 256 << 20;
// Items are grouped into rayon tasks of at least this many bytes, so tiny
// leaves don't drown in scheduling overhead.
const TASK_BYTES: u64 = 64 << 10;

pub struct Scan<'a> {
    input: &'a Input,
    hashed: AtomicU64,
    cancel: AtomicBool,
}

/// Runs `walk` beside the whole-file hasher; returns its result and the
/// file's digest.
pub fn with_file_digest<T>(input: &Input, walk: impl FnOnce(&Scan) -> Result<T>) -> Result<(T, Digest)> {
    let scan = Scan { input, hashed: AtomicU64::new(0), cancel: AtomicBool::new(false) };
    thread::scope(|scope| {
        let hasher = scope.spawn(|| scan.hash_file());
        let walked = walk(&scan);
        // A failed walk needs no digest: stop the hasher early.
        scan.cancel.store(walked.is_err(), Ordering::Relaxed);
        let digest = hasher.join().expect("hasher thread panicked");
        Ok((walked?, digest))
    })
}

impl Scan<'_> {
    fn hash_file(&self) -> Digest {
        let mut hasher = blake3::Hasher::new();
        for slice in self.input.bytes().chunks(HASHER_SLICE) {
            if self.cancel.load(Ordering::Relaxed) {
                break;
            }
            hasher.update(slice);
            self.hashed.fetch_add(slice.len() as u64, Ordering::Release);
        }
        self.hashed.store(u64::MAX, Ordering::Release);
        *hasher.finalize().as_bytes()
    }

    /// Before a step ending at `end`: asks for the bytes after it, then
    /// waits until the hasher is close enough behind.
    pub fn begin_step(&self, end: u64) {
        let size = self.input.bytes().len() as u64;
        self.input.prefetch(end.min(size) as usize..(end + PREFETCH).min(size) as usize);
        while end > self.hashed.load(Ordering::Acquire).saturating_add(AHEAD) {
            thread::sleep(Duration::from_millis(1));
        }
    }
}

/// The end of the step starting at item `first` of `count`: at most
/// `max_items` items, each starting within STEP_BYTES of the first.
pub fn step_end(first: u64, count: u64, max_items: u64, start: impl Fn(u64) -> u64) -> u64 {
    let origin = start(first);
    let limit = (first + max_items).min(count);
    let mut end = first + 1;
    while end < limit && start(end) - origin < STEP_BYTES {
        end += 1;
    }
    end
}

/// rayon's `with_min_len` for `count` items spanning `span` bytes.
pub fn min_task_len(span: u64, count: usize) -> usize {
    (TASK_BYTES / mean_len(span, count)).max(1) as usize
}

/// Items in a window of about STEP_BYTES, for `count` items spanning `span`.
pub fn window_len(span: u64, count: usize) -> usize {
    (STEP_BYTES / mean_len(span, count)).max(1) as usize
}

fn mean_len(span: u64, count: usize) -> u64 {
    (span / count.max(1) as u64).max(1)
}
