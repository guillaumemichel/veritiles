// The input file, memory-mapped: leaf, chunk and section boundaries never
// line up, and later profiles need random access, so a map avoids copying
// across buffer edges. The only `unsafe` in the crate lives here.
//
// A file larger than RAM is read from disk once, front to back. Page faults
// alone read it in small pieces, well under the disk's speed, so the map is
// advised sequential (larger readahead, pages dropped behind) and the pass
// asks for each next step ahead of time with `prefetch`.
use std::fs::File;
use std::io::Read;
use std::ops::Range;

use memmap2::{Advice, Mmap};

use crate::error::{Result, io_error, io_error_bare};

pub enum Input {
    Mapped(Mmap),
    // A file reporting size 0 cannot be mapped: empty, or a pseudo-file
    // (/proc) whose content only a read returns, as Node's readFile does.
    Read(Vec<u8>),
}

impl Input {
    pub fn open(path: &str) -> Result<Input> {
        let file = File::open(path).map_err(|e| io_error(&e, "open", path))?;
        let meta = file.metadata().map_err(|e| io_error(&e, "fstat", path))?;
        if meta.is_dir() {
            return Err("EISDIR: illegal operation on a directory, read".into());
        }
        if meta.len() == 0 {
            let mut bytes = Vec::new();
            (&file).read_to_end(&mut bytes).map_err(|e| io_error_bare(&e, "read"))?;
            return Ok(Input::Read(bytes));
        }
        // SAFETY: the map is read-only. A concurrent writer truncating the
        // file could fault the process; the packer documents that its input
        // must not change while it runs, as any hash-then-publish tool must.
        let map = unsafe { Mmap::map(&file) }.map_err(|e| io_error(&e, "mmap", path))?;
        // Advice is a hint: the pass is correct, if slower, without it.
        let _ = map.advise(Advice::Sequential);
        Ok(Input::Mapped(map))
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            Input::Mapped(map) => map,
            Input::Read(bytes) => bytes,
        }
    }

    /// Starts reading `range` of the map from disk in the background
    /// (madvise WILLNEED). A hint only: errors are ignored.
    pub fn prefetch(&self, range: Range<usize>) {
        if let Input::Mapped(map) = self
            && !range.is_empty()
        {
            let _ = map.advise_range(Advice::WillNeed, range.start, range.len());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefetch_takes_unaligned_and_empty_ranges() {
        let input = Input::open("Cargo.toml").unwrap();
        let before = input.bytes().to_vec();
        input.prefetch(1..before.len());
        input.prefetch(before.len()..before.len());
        assert_eq!(input.bytes(), before);
    }

    #[test]
    fn zero_size_files_are_read() {
        let proc = Input::open("/proc/version").unwrap();
        assert!(proc.bytes().starts_with(b"Linux"));
        assert!(Input::open("/dev/null").unwrap().bytes().is_empty());
    }
}
