// The proof tree under the descriptor's top meta (src/proof-index.ts): each
// meta must cover exactly the range its parent committed, each subdirectory
// meta must match its digest, and the shards it names are listed in file
// order. Shards themselves are read and checked with the leaves they carry.
use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest as _, Sha256};

use crate::codec::Digest;
use crate::error::{Result, io_error};
use crate::proof::format::{KIND_DIR, META_FILE_CAP, decode_meta, shard_name};

/// A shard the tree commits to: its proof-relative path, span, and digest.
#[derive(Debug, Clone)]
pub struct ShardRef {
    pub path: String,
    pub start: u64,
    pub length: u64,
    pub digest: Digest,
}

pub fn collect_shards(proofs: &Path, top_meta: &[u8], map_size: u64) -> Result<Vec<ShardRef>> {
    let mut shards = Vec::new();
    walk(proofs, "", 0, map_size, top_meta, &mut shards)?;
    Ok(shards)
}

fn walk(proofs: &Path, dir: &str, start: u64, length: u64, meta: &[u8], out: &mut Vec<ShardRef>) -> Result<()> {
    let (entries, covered) = decode_meta(meta, start)?;
    if covered != length {
        let label = if dir.is_empty() { "top meta".to_string() } else { format!("{dir}/meta") };
        return Err(format!("{label} covers {covered} bytes, expected {length}").into());
    }
    for entry in entries {
        let name = shard_name(entry.start);
        let path = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if entry.kind != KIND_DIR {
            out.push(ShardRef { path, start: entry.start, length: entry.length, digest: entry.digest });
            continue;
        }
        let child = read_checked(proofs, &format!("{path}/meta"), META_FILE_CAP, &entry.digest)?;
        walk(proofs, &path, entry.start, entry.length, &child, out)?;
    }
    Ok(())
}

/// A whole proof file, at most `cap` bytes, whose sha2-256 must be `digest`.
pub fn read_checked(proofs: &Path, path: &str, cap: usize, digest: &Digest) -> Result<Vec<u8>> {
    let full = proofs.join(path);
    let shown = full.to_string_lossy();
    let file = File::open(&full).map_err(|e| io_error(&e, "open", &shown))?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1).read_to_end(&mut bytes).map_err(|e| io_error(&e, "read", &shown))?;
    if bytes.len() > cap {
        return Err(format!("{path}: over the {cap}-byte cap").into());
    }
    if Sha256::digest(&bytes).as_slice() != digest {
        return Err(format!("{path}: digest mismatch").into());
    }
    Ok(bytes)
}
