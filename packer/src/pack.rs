// `pack <input>`: profile selection, layout, the hashing pass, and output
// files — `root` last, so a reader that finds it can trust every file it
// names was written first.
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;

use rayon::prelude::*;
use sha2::{Digest as _, Sha256};

use crate::args::PackArgs;
use crate::car::CarWriter;
use crate::codec::cid::{self, DAG_CBOR};
use crate::error::{Error, Result, io_error};
use crate::input::Input;
use crate::nodefs::{dirname, mkdirp, resolve};
use crate::pass::{Pass, UnixFs, hash_pass};
use crate::plan::pmtiles::{self, Parsed, ranges::Groups};
use crate::plan::{Leaves, cuts, mp4};
use crate::proof::descriptor;
use crate::proof::tree::{FileRef, Layout, Limits, Meta, plan, shard_count};

const DEFAULT_CHUNK: u64 = 1 << 20;
// The pmtiles profile's default tile group is the smallest of these that
// keeps every shard in the top meta (tools/pack.ts TILE_GROUP_CANDIDATES).
const TILE_GROUP_CANDIDATES: [u64; 3] = [16 << 10, 32 << 10, 64 << 10];

/// What the CLI reports on success.
pub struct Packed {
    pub anchor: String,
    pub map_cid: String,
    pub unixfs_cid: Option<String>,
    pub leaf_count: u64,
    /// Proof files including `root`.
    pub file_count: usize,
    pub descriptor_len: usize,
    /// The pmtiles profile's tile group budget, chosen or explicit.
    pub tile_group: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    Fixed,
    Pmtiles,
    Mp4,
}

pub fn pack(args: &PackArgs) -> Result<Packed> {
    refuse_outputs(args)?;
    let input = Input::open(&args.input)?;
    match select_profile(args, input.bytes())? {
        Profile::Fixed => pack_fixed(&input, args),
        Profile::Pmtiles => pack_pmtiles(&input, args),
        Profile::Mp4 => pack_band(&input, Leaves::Spans(mp4::leaf_spans(input.bytes())?), args),
    }
}

// Selects the profile and rejects options the chosen profile ignores.
fn select_profile(args: &PackArgs, bytes: &[u8]) -> Result<Profile> {
    let profile = match args.profile.as_deref() {
        None | Some("auto") => detect_profile(bytes),
        Some("fixed") => Profile::Fixed,
        Some("pmtiles") => Profile::Pmtiles,
        Some("mp4") => Profile::Mp4,
        Some(other) => return Err(format!("unknown profile: {other}").into()),
    };
    if profile != Profile::Fixed && args.chunk.is_some() {
        return Err("--chunk applies only to the fixed profile".into());
    }
    if profile != Profile::Pmtiles && args.tile_group.is_some() {
        return Err("--tile-group applies only to the pmtiles profile".into());
    }
    Ok(profile)
}

// `--profile auto`: PMTiles v3 by its magic, then fragmented MP4, else fixed.
fn detect_profile(bytes: &[u8]) -> Profile {
    if pmtiles::is_pmtiles_v3(bytes) {
        return Profile::Pmtiles;
    }
    if mp4::is_fragmented_mp4(bytes) { Profile::Mp4 } else { Profile::Fixed }
}

fn pack_fixed(input: &Input, args: &PackArgs) -> Result<Packed> {
    let chunk = args.chunk.unwrap_or(DEFAULT_CHUNK);
    if chunk == 0 {
        return Err(format!("bad chunk size: {chunk}").into());
    }
    pack_band(input, Leaves::Fixed { chunk, size: input.bytes().len() as u64 }, args)
}

// The fixed and mp4 profiles: every leaf in one band.
fn pack_band(input: &Input, leaves: Leaves, args: &PackArgs) -> Result<Packed> {
    let band = 0..leaves.count();
    let layout = plan(&leaves, std::slice::from_ref(&band), Limits::default())?;
    write_outputs(input, &leaves, &layout, args)
}

// Zoom-shaped leaves: tile groups up to the --tile-group budget (chosen from
// the archive by default), cut at every section boundary, banded by zoom.
fn pack_pmtiles(input: &Input, args: &PackArgs) -> Result<Packed> {
    let bytes = input.bytes();
    let parsed = pmtiles::parse(bytes)?;
    let budget = match args.tile_group {
        Some(budget) => budget,
        None => choose_tile_group(&parsed, bytes.len() as u64, Limits::default())?,
    };
    let groups = Groups::new(&parsed.tiles, budget);
    let spans = cuts::leaf_spans(bytes.len() as u64, &parsed.boundaries, &groups);
    let bands = cuts::bands(&spans, parsed.tile_data.clone(), &groups)?;
    // The tile index takes GiBs on large archives; the pass needs none of it.
    drop(groups);
    drop(parsed);
    let leaves = Leaves::Spans(spans);
    let layout = plan(&leaves, &bands, Limits::default())?;
    Ok(Packed { tile_group: Some(budget), ..write_outputs(input, &leaves, &layout, args)? })
}

/// The default tile group for a parsed archive (tools/pack.ts
/// choosePmtilesTileGroup): the first candidate whose shards all fit in the
/// top meta, so that every band is inlined there; the largest when none
/// does. It counts shards and hashes nothing, planning one candidate at a
/// time. `limits` is a test hook.
pub fn choose_tile_group(parsed: &Parsed, file_len: u64, limits: Limits) -> Result<u64> {
    for budget in TILE_GROUP_CANDIDATES {
        if shard_total(parsed, file_len, budget)? <= limits.top_max {
            return Ok(budget);
        }
    }
    let [.., largest] = TILE_GROUP_CANDIDATES;
    Ok(largest)
}

// `plan` inlines every band exactly when the shards of all bands fit in the
// top meta together: each band has a shard, so the slots kept for later
// bands are then free, and no band can outgrow a meta (the top meta's 1,598
// entries are fewer than a meta's 6,393).
fn shard_total(parsed: &Parsed, file_len: u64, budget: u64) -> Result<usize> {
    let groups = Groups::new(&parsed.tiles, budget);
    let spans = cuts::leaf_spans(file_len, &parsed.boundaries, &groups);
    let bands = cuts::bands(&spans, parsed.tile_data.clone(), &groups)?;
    let leaves = Leaves::Spans(spans);
    Ok(bands.into_iter().map(|band| shard_count(&leaves, band)).sum())
}

// Proof files (`root` last), then the full CAR is renamed into place, as in
// tools/pack.ts — which also writes every proof file before it reports a
// CAR path it cannot open.
fn write_outputs(input: &Input, leaves: &Leaves, layout: &Layout, args: &PackArgs) -> Result<Packed> {
    let out = args.out.as_str();
    create_dirs(layout, out)?;
    refuse_input_aliases(args, layout)?;
    let (unixfs, car_error) = unixfs_mode(args);
    let pass = hash_pass(input, leaves, layout, out, unixfs)?;
    let packed = write_proofs(input.bytes(), leaves, layout, out, &pass)?;
    if let Some(err) = car_error {
        return Err(err);
    }
    if let (Some(car), Some(root)) = (pass.car, pass.unixfs) {
        car.commit(&root)?;
    }
    Ok(packed)
}

// A CAR that cannot be opened fails only once the proofs are written; until
// then the pass still computes the UnixFS root they commit to.
fn unixfs_mode(args: &PackArgs) -> (UnixFs, Option<Error>) {
    match args.full_car.as_deref().map(CarWriter::create) {
        Some(Ok(car)) => (UnixFs::Car(car), None),
        Some(Err(err)) => (UnixFs::Root, Some(err)),
        None if args.unixfs => (UnixFs::Root, None),
        None => (UnixFs::Off, None),
    }
}

fn write_proofs(bytes: &[u8], leaves: &Leaves, layout: &Layout, out: &str, pass: &Pass) -> Result<Packed> {
    let (metas, top) = layout.seal(&pass.proofs.shard_digests);
    let write_meta = |(meta, content): (&Meta, &Vec<u8>)| write_file(out, &meta.path, content);
    layout.metas.par_iter().zip(&metas).map(write_meta).collect::<Result<()>>()?;
    let map = cid::map_cid_bytes(&pass.proofs.map_digest);
    let root = descriptor::encode(&map, pass.unixfs.as_ref(), &top, bytes.len() as u64);
    write_file(out, "root", &root)?;
    Ok(Packed {
        anchor: cid::to_text(&cid::cid_bytes(DAG_CBOR, &Sha256::digest(&root).into())),
        map_cid: cid::to_text(&map),
        unixfs_cid: pass.unixfs.as_ref().map(|root| cid::to_text(root)),
        leaf_count: leaves.count(),
        file_count: layout.files.len() + 1,
        descriptor_len: root.len(),
        tile_group: None,
    })
}

// The directories tools/pack.ts makes before each proof file, in its file
// order (`root` last), each once.
fn create_dirs(layout: &Layout, out: &str) -> Result<()> {
    let mut made = HashSet::new();
    for path in proof_paths(layout) {
        let dir = dirname(&output_path(out, path)).to_string();
        if made.insert(dir.clone()) {
            mkdirp(&dir)?;
        }
    }
    Ok(())
}

fn proof_paths(layout: &Layout) -> impl Iterator<Item = &str> {
    let paths = layout.files.iter().map(|&file| match file {
        FileRef::Shard(i) => layout.shards[i].path.as_str(),
        FileRef::Meta(i) => layout.metas[i].path.as_str(),
    });
    paths.chain(["root"])
}

// Existing outputs that are the input file (a hardlink, or a path through a
// symlink) are refused before any output is opened: truncating one would
// fault the input map. The path checks of `refuse_outputs` miss these.
fn refuse_input_aliases(args: &PackArgs, layout: &Layout) -> Result<()> {
    let Ok(input) = fs::metadata(&args.input) else { return Ok(()) };
    let is_input =
        |path: &str| fs::metadata(path).is_ok_and(|meta| meta.dev() == input.dev() && meta.ino() == input.ino());
    if proof_paths(layout).any(|path| is_input(&output_path(&args.out, path))) {
        return Err("--out contains the input file".into());
    }
    if args.full_car.as_ref().is_some_and(|car| is_input(&format!("{car}.tmp"))) {
        return Err("--full-car resolves to the input file".into());
    }
    Ok(())
}

/// A proof file's path as tools/pack.ts builds it: `${out}/${path}`, not
/// normalised, so error messages match.
pub fn output_path(out: &str, path: &str) -> String {
    format!("{out}/{path}")
}

fn write_file(out: &str, path: &str, content: &[u8]) -> Result<()> {
    let full = output_path(out, path);
    fs::write(&full, content).map_err(|e| io_error(&e, "open", &full))
}

// Outputs that would overwrite the mapped input (or replace a directory
// holding it) are refused, by path as tools/pack.ts compares them.
fn refuse_outputs(args: &PackArgs) -> Result<()> {
    let input = resolve(&args.input)?;
    let out = resolve(&args.out)?;
    if out == input {
        return Err("--out resolves to the input file".into());
    }
    if input.starts_with(&format!("{out}/")) {
        return Err("--out contains the input file".into());
    }
    let Some(full_car) = &args.full_car else { return Ok(()) };
    if resolve(full_car)? == input || resolve(&format!("{full_car}.tmp"))? == input {
        return Err("--full-car resolves to the input file".into());
    }
    Ok(())
}
