// The UnixFS file DAG a default Kubo/ipfs-unixfs-importer import builds:
// CIDv1, raw 256 KiB leaves, balanced layout with 174 links per node. It is
// built in one streaming pass from chunk digests, and every block goes to
// `emit` in DAG post-order (children left to right, then the parent).
use sha2::{Digest as _, Sha256};

use crate::codec::Digest;
use crate::codec::cid::{CidBytes, DAG_PB, RAW, cid_bytes};
use crate::codec::varint::push_varint;
use crate::error::Result;

pub const CHUNK: usize = 256 << 10;
const FANOUT: usize = 174;
const UNIXFS_FILE: u8 = 2;
// Encoded size estimates for a parent block's capacity: a link with its
// CID and tsize, a blocksize entry, and the Data field's head.
const LINK_BYTES: usize = 48;
const BLOCKSIZE_BYTES: usize = 4;
const DATA_HEAD_BYTES: usize = 16;

/// Receives each block as it is built; repeated blocks arrive again.
pub type Emit<'a> = dyn FnMut(&CidBytes, &[u8]) -> Result<()> + 'a;

/// A child as its parent links to it.
#[derive(Debug, Clone, Copy)]
struct Link {
    cid: CidBytes,
    // The child's file bytes, and its whole subtree's block bytes.
    file_size: u64,
    tree_size: u64,
}

pub struct Builder {
    chunk: usize,
    fanout: usize,
    chunks: usize,
    // Links waiting for a parent, per level (0 = leaves), and how many each
    // level has received in total.
    pending: Vec<Vec<Link>>,
    pushed: Vec<u64>,
}

impl Default for Builder {
    fn default() -> Self {
        Builder::new()
    }
}

impl Builder {
    pub fn new() -> Builder {
        Builder::with_shape(CHUNK, FANOUT)
    }

    /// A smaller chunk and fanout reach deep trees with small test inputs.
    pub fn with_shape(chunk: usize, fanout: usize) -> Builder {
        assert!(chunk > 0 && fanout > 1);
        Builder { chunk, fanout, chunks: 0, pending: Vec::new(), pushed: Vec::new() }
    }

    /// The digests of the next chunks of `file`, in order.
    pub fn push_chunks(&mut self, file: &[u8], digests: &[Digest], emit: &mut Emit) -> Result<()> {
        for digest in digests {
            let start = (self.chunks * self.chunk).min(file.len());
            let bytes = &file[start..(start + self.chunk).min(file.len())];
            let link =
                Link { cid: cid_bytes(RAW, digest), file_size: bytes.len() as u64, tree_size: bytes.len() as u64 };
            emit(&link.cid, bytes)?;
            self.chunks += 1;
            self.push(0, link, emit)?;
        }
        Ok(())
    }

    // Full levels reduce eagerly, as the importer batches each level.
    fn push(&mut self, level: usize, link: Link, emit: &mut Emit) -> Result<()> {
        if self.pending.len() == level {
            self.pending.push(Vec::new());
            self.pushed.push(0);
        }
        self.pending[level].push(link);
        self.pushed[level] += 1;
        if self.pending[level].len() < self.fanout {
            return Ok(());
        }
        let parent = self.reduce(level, emit)?;
        self.push(level + 1, parent, emit)
    }

    fn reduce(&mut self, level: usize, emit: &mut Emit) -> Result<Link> {
        let links = std::mem::take(&mut self.pending[level]);
        let block = encode_parent(&links);
        let cid = cid_bytes(DAG_PB, &Sha256::digest(&block).into());
        emit(&cid, &block)?;
        let file_size = links.iter().map(|l| l.file_size).sum();
        let tree_size = block.len() as u64 + links.iter().map(|l| l.tree_size).sum::<u64>();
        Ok(Link { cid, file_size, tree_size })
    }

    /// The root CID. A level that ever held one node holds the root; below
    /// that, leftover links get a parent even when there is only one.
    pub fn finish(mut self, emit: &mut Emit) -> Result<CidBytes> {
        assert!(self.chunks > 0, "a file has at least one chunk");
        let mut level = 0;
        while self.pushed[level] > 1 {
            if !self.pending[level].is_empty() {
                let parent = self.reduce(level, emit)?;
                self.push(level + 1, parent, emit)?;
            }
            level += 1;
        }
        Ok(self.pending[level][0].cid)
    }
}

// dag-pb PBNode: links first, then Data (a UnixFS file node), as
// @ipld/dag-pb encodes; every link has an empty name.
fn encode_parent(links: &[Link]) -> Vec<u8> {
    let mut out = Vec::with_capacity(links.len() * (LINK_BYTES + BLOCKSIZE_BYTES) + DATA_HEAD_BYTES);
    for link in links {
        let mut body = vec![0x0a, 36];
        body.extend_from_slice(&link.cid);
        body.extend_from_slice(&[0x12, 0x00, 0x18]);
        push_varint(&mut body, link.tree_size);
        out.push(0x12);
        push_varint(&mut out, body.len() as u64);
        out.extend_from_slice(&body);
    }
    let mut data = vec![0x08, UNIXFS_FILE, 0x18];
    push_varint(&mut data, links.iter().map(|l| l.file_size).sum());
    for link in links {
        data.push(0x20);
        push_varint(&mut data, link.file_size);
    }
    out.push(0x0a);
    push_varint(&mut out, data.len() as u64);
    out.extend_from_slice(&data);
    out
}
