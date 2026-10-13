// `pack verify`: an independent full check of a package, in one pass.
// The anchor names `root`; the strict descriptor commits the file size, the
// map CID, and the top meta; the tree walk lists every shard; then one pass
// over the file checks every leaf against its shard (in parallel) while the
// hasher thread recomputes the whole-file BLAKE3 map CID.
pub mod anchor;
pub mod tree;

use std::ops::Range;
use std::path::Path;

use rayon::prelude::*;
use sha2::{Digest as _, Sha256};

use crate::args::VerifyArgs;
use crate::codec::Digest;
use crate::error::Result;
use crate::input::Input;
use crate::proof::descriptor;
use crate::proof::format::{DESCRIPTOR_CAP, Leaf, SHARD_FILE_CAP, shard_leaves, validate_shard};
use crate::scan::{Scan, min_task_len, step_end, window_len, with_file_digest};
use tree::{ShardRef, collect_shards, read_checked};

// Shards read together in a step, bounded so its leaves fit in memory. Its
// leaves are hashed a window at a time, so the leaf hashers stay near the
// hasher thread even when one shard spans GiBs.
const STEP_SHARDS: u64 = 512;

pub fn verify(args: &VerifyArgs) -> Result<()> {
    let anchor = anchor::parse_file_anchor(&args.cid)?;
    let proofs = Path::new(&args.proofs);
    let root = read_checked(proofs, "root", DESCRIPTOR_CAP, &anchor)?;
    let descriptor = descriptor::decode(&root)?;
    // The file's real size bounds the tree walk: the walk only lists
    // shards that cover the committed size.
    let input = Input::open(&args.file)?;
    let size = input.bytes().len();
    if size as u64 != descriptor.map_size {
        return Err(format!("file is {size} bytes, descriptor says {}", descriptor.map_size).into());
    }
    let shards = collect_shards(proofs, &descriptor.top_meta, descriptor.map_size)?;
    if check_content(&input, proofs, &shards)? != descriptor.map_digest {
        return Err("map CID does not match the file".into());
    }
    Ok(())
}

// Every leaf against its shard; returns the whole-file digest.
fn check_content(input: &Input, proofs: &Path, shards: &[ShardRef]) -> Result<Digest> {
    let bytes = input.bytes();
    let walk = |scan: &Scan| steps(shards).try_for_each(|step| check_step(scan, bytes, proofs, &shards[step]));
    let ((), digest) = with_file_digest(input, walk)?;
    Ok(digest)
}

fn steps(shards: &[ShardRef]) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut first = 0;
    std::iter::from_fn(move || {
        if first == shards.len() {
            return None;
        }
        let count = shards.len() as u64;
        let end = step_end(first as u64, count, STEP_SHARDS, |i| shards[i as usize].start) as usize;
        Some(std::mem::replace(&mut first, end)..end)
    })
}

// Hashes the step's leaves in parallel, a window at a time; the first
// failure in file order is the error.
fn check_step(scan: &Scan, bytes: &[u8], proofs: &Path, shards: &[ShardRef]) -> Result<()> {
    let leaves = read_leaves(proofs, shards)?;
    let span = shards.iter().map(|shard| shard.length).sum::<u64>();
    let min_len = min_task_len(span, leaves.len());
    let differs = |(_, leaf): &&(usize, Leaf)| {
        Sha256::digest(&bytes[leaf.offset as usize..(leaf.offset + leaf.length) as usize]).as_slice() != leaf.digest
    };
    for window in leaves.chunks(window_len(span, leaves.len())) {
        let (_, last) = &window[window.len() - 1];
        scan.begin_step(last.offset + last.length);
        if let Some((index, leaf)) = window.par_iter().with_min_len(min_len).find_first(differs) {
            let path = &shards[*index].path;
            return Err(format!("leaf at {}+{} ({path}): digest mismatch", leaf.offset, leaf.length).into());
        }
    }
    Ok(())
}

// Reads and validates the step's shards in parallel, each leaf tagged with
// its shard's index in the step; the first failure in file order is the
// error.
fn read_leaves(proofs: &Path, shards: &[ShardRef]) -> Result<Vec<(usize, Leaf)>> {
    let read = |shard: &ShardRef| {
        let file = read_checked(proofs, &shard.path, SHARD_FILE_CAP, &shard.digest)?;
        validate_shard(&file, shard.length, &shard.path)?;
        Ok(shard_leaves(&file, shard.start, shard.length))
    };
    let per_shard: Vec<Result<_>> = shards.par_iter().map(read).collect();
    let mut leaves = Vec::new();
    for (index, shard_leaves) in per_shard.into_iter().enumerate() {
        leaves.extend(shard_leaves?.into_iter().map(|leaf| (index, leaf)));
    }
    Ok(leaves)
}
