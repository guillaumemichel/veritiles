// The full CAR (CARv1): a 59-byte header naming the root, then one section
// per unique block in the order given. Written to `<path>.tmp` with the
// header reserved up front (the root is known only at the end), and renamed
// by `commit`, so a crash never leaves a truncated CAR under the final name.
// A writer dropped uncommitted (any failure) removes its `.tmp`, as
// tools/pack.ts does.
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, IoSlice, Seek, SeekFrom, Write};

use crate::codec::cbor::TAG42_CID;
use crate::codec::cid::CidBytes;
use crate::codec::varint::push_varint;
use crate::error::{Error, Result, io_error};
use crate::unixfs::CHUNK;

// The header: its length varint (58), then dag-cbor {roots: [root],
// version: 1}, keys in canonical order.
const HEADER_HEAD: &[u8] = b"\x3a\xa2\x65roots\x81";
const HEADER_TAIL: &[u8] = b"\x67version\x01";
const HEADER_LEN: usize = HEADER_HEAD.len() + TAG42_CID.len() + size_of::<CidBytes>() + HEADER_TAIL.len();

pub struct CarWriter {
    out: BufWriter<File>,
    path: String,
    tmp: String,
    seen: HashSet<CidBytes>,
    committed: bool,
}

impl CarWriter {
    pub fn create(path: &str) -> Result<CarWriter> {
        let tmp = format!("{path}.tmp");
        let file = File::create(&tmp).map_err(|e| io_error(&e, "open", &tmp))?;
        // Leaf sections exceed the buffer, so they go straight to writev
        // from the input map; only the small parent blocks are buffered.
        let out = BufWriter::with_capacity(CHUNK, file);
        let mut car = CarWriter { out, path: path.to_string(), tmp, seen: HashSet::new(), committed: false };
        car.out.write_all(&[0; HEADER_LEN]).map_err(|e| io_error(&e, "write", &car.tmp))?;
        Ok(car)
    }

    /// Appends a section unless this CID was already written.
    pub fn block(&mut self, cid: &CidBytes, bytes: &[u8]) -> Result<()> {
        if !self.seen.insert(*cid) {
            return Ok(());
        }
        let head = section_head(cid, bytes.len());
        write_all_vectored(&mut self.out, &mut [IoSlice::new(&head), IoSlice::new(bytes)])
            .map_err(|e| io_error(&e, "write", &self.tmp))
    }

    /// Writes the header, flushes, and moves `<path>.tmp` to `path`.
    pub fn commit(mut self, root: &CidBytes) -> Result<()> {
        let fail = |e: std::io::Error| io_error(&e, "write", &self.tmp);
        self.out.flush().map_err(fail)?;
        let file = self.out.get_mut();
        file.seek(SeekFrom::Start(0)).map_err(fail)?;
        file.write_all(&header(root)).map_err(fail)?;
        std::fs::rename(&self.tmp, &self.path).map_err(|e| rename_error(&e, &self.tmp, &self.path))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for CarWriter {
    // Best effort: the error being reported matters more than this one.
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

// Node words a rename failure with both paths.
fn rename_error(err: &std::io::Error, from: &str, to: &str) -> Error {
    io_error(err, "rename", from).0.replacen(&format!("'{from}'"), &format!("'{from}' -> '{to}'"), 1).into()
}

/// A section's length varint and CID; the block bytes follow.
pub fn section_head(cid: &CidBytes, block_len: usize) -> Vec<u8> {
    let mut head = Vec::with_capacity(48);
    push_varint(&mut head, (cid.len() + block_len) as u64);
    head.extend_from_slice(cid);
    head
}

pub fn header(root: &CidBytes) -> [u8; HEADER_LEN] {
    let header = [HEADER_HEAD, TAG42_CID, root, HEADER_TAIL].concat();
    header.try_into().expect("HEADER_LEN bytes")
}

fn write_all_vectored(out: &mut impl Write, mut slices: &mut [IoSlice]) -> std::io::Result<()> {
    while !slices.is_empty() {
        let written = match out.write_vectored(slices) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if written == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        IoSlice::advance_slices(&mut slices, written);
    }
    Ok(())
}
