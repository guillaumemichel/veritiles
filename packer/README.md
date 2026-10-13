# veritiles-pack

A Rust port of the veritiles packer (`tools/pack.ts`). It produces the same
bytes as the TS packer — anchor, proof files, CARs, stdout and stderr — but
memory-maps its input and hashes in parallel, so it packs files of any size
(a 100+ GB planet PMTiles) with bounded memory. The TS packer reads the whole
input into memory and stops near 2 GiB.

Like the TS packer, it is a repository development tool, not part of the
published `veritiles` npm package.

## Build

Needs a recent stable Rust (CI uses 1.95) and a C compiler, which builds the
bundled zstd.

```sh
cd packer
cargo build --release   # → target/release/veritiles-pack
```

From the repository root, `npm run pack:rs -- …` builds if needed and runs it.

## Usage

```sh
veritiles-pack <input> [--profile auto|fixed|pmtiles|mp4] [--chunk N]
               [--tile-group N] [--unixfs] [--full-car pin.car] [--out dir]
veritiles-pack assets <dir> [--out bundle.car] [--type ext=mime]
veritiles-pack verify --cid <anchor> --file <path> --proofs <dir>
```

**pack** writes `<input>.proofs/` (or `--out`), prints the anchor on stdout,
and reports the leaf count, the tile group (`pmtiles` profile), the `map`
CID and the optional `unixfs` CID on stderr.

- `--profile`: `auto` (default) picks `pmtiles` for a PMTiles v3 archive,
  `mp4` for a fragmented MP4 (an `ftyp` box first, then a top-level `moof`),
  and `fixed` otherwise. Forcing `pmtiles` or `mp4` on another file is an
  error.
- `--chunk N`: leaf size for the `fixed` profile (default 1 MiB).
- `--tile-group N`: tile grouping budget for the `pmtiles` profile. By
  default it is chosen from the file: the smallest of 16, 32 and 64 KiB that
  keeps every shard listed in the descriptor, else 64 KiB. `0` gives one
  leaf per tile.
- `--unixfs`: also embed the file's UnixFS CID (256 KiB raw leaves, 174
  links per node, as `ipfs add --cid-version 1 --raw-leaves`).
- `--full-car pin.car`: with `--unixfs`, also write that DAG as a CAR.

Sizes take a `K`/`KiB` or `M`/`MiB` suffix. Flags are strict: an unknown
flag, a missing value, an extra argument or a flag the chosen profile
ignores is an error.

The `mp4` profile cuts leaves where a video player reads: one for the init
section (everything before the first fragment: `ftyp`, `moov`, `sidx`…),
one per fragment (a `moof` and its `mdat`s, with any `styp`, `emsg` or
`prft` boxes before the `moof`), and one for any boxes after the last
`mdat` (an `mfra`). A player that fetches each fragment at the range its
`sidx` lists then downloads exactly that fragment, one leaf, with no
neighbouring bytes. Leaves have no size cap. The profile reads top-level box
headers only and covers audio-only `.m4a` files and single-index DASH tracks
(YouTube's) too; a regular, non-fragmented MP4 packs as `fixed`. Once a file
is taken as fragmented MP4, a malformed box (a truncated download, a size
past the end of the file) fails the pack. Files that put a `sidx` before
every fragment (ffmpeg's single-file HLS and DASH outputs) keep the first
one in the init leaf, so only the first fragment's range spans two leaves.

**assets** walks `<dir>`, writes a MASL bundle CAR to `--out` (default
`bundle.car`) and prints the manifest anchor. `--type ext=mime[,…]` adds or
overrides content types by file extension.

**verify** checks a package completely: the anchor against `root`, the
descriptor, every meta and shard, the file length, every leaf digest and the
whole-file BLAKE3 `map` CID. It prints `verify OK` or exits 1 with the first
failure.

## Differences from the TS packer

- No URL input. Download first: `curl -o map.pmtiles https://…`.
- `verify` hashes the whole file; the TS `verify` opens a real client and
  spot-reads 64 random ranges. Both print `verify OK`, but their failure
  messages differ.
- Linux first: CI runs on Ubuntu, and the code uses Unix-only APIs.

## Limitations

- The input is memory-mapped: truncating or rewriting it while `pack` runs
  can kill the process with SIGBUS. Do not pack a file that is still being
  written.
- No URL input (see above).
- The packer refuses outputs that would overwrite the input: by resolved
  path (`--out` equal to or containing it, `--full-car` or its `.tmp` equal
  to it), and by device and inode for proof files and `<full-car>.tmp` that
  already exist (a symlink or hard link to the input). An output created
  as an alias while `pack` runs is not detected.
- PMTiles directories and metadata may decompress to at most 256 MiB per
  block, and an archive may list at most 2^30 tile entries (both CLIs).

## Parity

`test/pack-diff.test.ts` runs both CLIs over a fixed-seed corpus (sizes
around chunk and node boundaries, PMTiles variants and malformed archives,
fragmented MP4 layouts, asset directories, verify cases) and compares exit
status, stdout, stderr and every output file byte for byte. It is not part
of `npm test`, and it skips until the release binary exists (in CI it fails
instead):

```sh
cargo build --release --manifest-path packer/Cargo.toml
npm run test:diff
```

`cargo test` covers the Rust side against vectors exported from the TS code
(`tests/fixtures/`).
