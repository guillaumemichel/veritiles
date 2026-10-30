# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor = feature, patch =
fix).

## [Unreleased]

### Fixed

- The MapLibre examples (`examples/maplibre.html`, `hints.html`,
  `assets.html`) and the README's MapLibre snippet import MapLibre GL's ES
  module. MapLibre 6 ships no `maplibre-gl.js`, so they stopped at a 404
  before drawing a tile. They now pin MapLibre GL 6.16.0 and PMTiles 4.5.0.
- The OpenLayers example pins OpenLayers 9.2.4: ol-pmtiles 2.0.2's browser
  bundle throws on the first tile with OpenLayers 10, so the example drew
  nothing.

## [0.6.1] — Verified sprites

### Fixed

- `assetProtocol` answers each request in the form MapLibre asks for: a
  `json` request, such as a sprite index or a style, with the parsed value, a
  `string` request with the text, any other with the bytes. MapLibre parses
  nothing a protocol returns, so a sprite sheet in a verified bundle
  (`"sprite": "verified://<anchor>/sprite"`, as in the README) loaded no icons.

## [0.6.0] — Routers

### Added

- **Routers** ([`SPEC.md` §6](https://github.com/anymirror-dev/anymirror/blob/v0.6.0/SPEC.md#6-routers)): every location now comes from a router. The
  built-in one follows `source`, `proof` and `hints` as before; a `router`
  option on `VerifiedSource`, `VerifiedFile` and `VerifiedAsset` replaces it
  with your own — a content-routing index, a gateway, a table — so a page can
  ship only its anchor and find hosts at runtime. A router's `locate(cid,
  { defaults })` yields the URLs of a CID's bytes, best first, and gets the
  built-in router's locations as `defaults`, so its yield order is its
  strategy: the page's own hosts first, its own first, or whichever answer
  first. The client reads the stream lazily, taking the next location only
  when the ones it holds have failed, and asks again once all have. A located
  URL is where the CID's own bytes are, the rule of
  [FISL](https://dasl.ing/fisl.html): for a ranged file's anchor that is
  `{proof}/root`, and the client reads the proof tree beside it. A router may
  also carry the requests (`fetch`): each comes with the CID, the location,
  the client's own fetch, and a verdict — `verified`, `rejected`, `failed` or
  `unused` — so a router learns which hosts serve, how fast, and which lie,
  and can add credentials. Routers are as untrusted as hints documents: every
  byte still verifies against the anchor. The README shows a router over a
  FISL index in a few lines.
- `pack assets` also writes the manifest block alone beside the CAR
  (`bundle.car` → `bundle.masl`): the anchor's own bytes, the file a router
  names for a bundle. Clients accept a bare manifest block wherever they read
  a bundle proof: a body that hashes to the anchor is the block, anything else
  is read as a CAR.

### Changed

- **A failing location is demoted.** A location that fails in transport — a
  network error, a non-2xx status, a `200` to a `Range` request, a missing
  proof file — now moves behind the ones that have not failed until it serves
  again, instead of being tried first on every read; a fetch asks the router
  for a fresh location before going back to it, and gives up after 16 failed
  locations. A location that serves wrong bytes is still banned, now for the
  client's whole session (a failed open no longer forgets it), and only for
  the CID it got wrong: for any other it is demoted.
- **Explicit hints documents no longer hold up the open.** A page that
  configures its locations and names a `hints` document sends `root`, the
  first proof piece and the first read's range at once, and fetches the
  document in the background; its URLs still back up the configured ones.
- A bundle file that fails verification at a configured base bans that
  file's URL, not the whole base: the base still serves the bundle's other
  files.
- The router specification lands in `SPEC.md` as **§6 Routers**; the previous
  §6–§9 (Hosts, Publishing, IPFS interoperability, Non-goals) are renumbered
  §7–§10.

### Fixed

- A response body that arrives in one piece is copied before it is verified:
  a `fetchFn` (or a router's `fetch`) that reuses its buffers can no longer
  change bytes after they verified.
- A read whose signal aborts stops waiting for a file's open or a bundle's
  manifest; the open goes on for other reads.

## [0.5.0] — Planet scale

**Planet scale.** A Rust port of the packer packs files of any size — a
130 GiB planet included — writing the same bytes as the TS packer. Packs now
cut leaves where readers read: PMTiles archives choose their tile groups
from the file, and fragmented MP4s get one leaf per fragment. With a client
that sends the descriptor, the first proof piece and the first read
together, a cold map view or video start costs little more than an
unverified one. Breaking: a descriptor's `map` is now the file's BLAKE3
CID, so v0.4 packs must be re-packed.

### Added

- **Rust packer** (`packer/`, `npm run pack:rs -- …`): a port of the
  repository packer for files the TS packer cannot hold in memory (~2 GiB
  and up, such as a planet-scale PMTiles). It memory-maps the input, hashes
  in parallel, and writes the same bytes as `tools/pack.ts` — anchor, proof
  files, CARs, stdout and stderr — enforced by a differential test
  (`test/pack-diff.test.ts`). Local files only; its `verify` checks every
  byte. See `packer/README.md`.
- `npm run test:diff` runs that differential test; `npm test` no longer
  does. CI builds the binary and fails, rather than skips, without it.
- **`mp4` packer profile.** `--profile auto` packs a fragmented MP4 (an
  `ftyp` box first, then a top-level `moof`) with one leaf per fragment:
  its `moof` and `mdat`s, with any `styp`, `emsg` or `prft` boxes that open
  it. The init section and any boxes after the last `mdat` (an `mfra`) get
  a leaf each. A player that reads each fragment at the range its `sidx`
  lists, as Media Source Extensions players do, downloads exactly that
  fragment in one round trip instead of the whole 1 MiB leaves around it.
  Verified playback then keeps pace with an unverified player: a
  YouTube-style source (video and audio tracks) starts in 247 ms instead of
  947 ms at 50 ms RTT and 20 Mbit/s (unverified: 265 ms), downloading
  0.49 MB instead of 2.23 MB, and seeks in 453 ms instead of 892 ms
  (unverified: 451 ms). Audio-only `.m4a` files qualify; a regular MP4 still
  packs as `fixed`, and `--profile mp4` forces the profile. Once a file is
  taken as fragmented MP4, a malformed box, such as a truncated download,
  fails the pack.

### Changed

- **Breaking:** a descriptor's `map` is the file's raw BLAKE3 CID (BDASL,
  `bafkr4i…`) instead of its sha2-256 CID. No client computes `map` — it
  names the file, for content hints — so the packers no longer run the one
  step that could not be parallelized: a single SHA-256 stream over the
  whole file. The Rust packer packs a file in memory 2–3.5× faster, and a
  file larger than RAM is now bound by the disk rather than the hash.
  Clients reject a sha2-256 `map`, so v0.4 packs must be re-packed, and v0.4
  clients reject v0.5 packs. Every hash a client checks — anchors, proof
  files, leaves, assets — stays sha2-256 (WebCrypto). Hints documents accept
  raw BLAKE3 CIDs as keys. The TS packer computes BLAKE3 with the
  `hash-wasm` dev dependency.
- **Faster first paint.** The client requests the descriptor, the first
  proof shard (`0`) and the first read's range in one round trip, each
  still verified before use, and requests the proof shards covering a read
  (after any directory metas) before that read's speculative tile data, so
  a shard never waits behind tile bytes. With the new tile-group default
  below, a cold view of the Protomaps planet shows its first tile in
  301–366 ms instead of 764–1,350 ms at 50 ms RTT and 20 Mbit/s (plain
  PMTiles: 201–266 ms); on a terrain archive shaped like Mapterhorn's planet
  (331 GiB, z0–z12), a cold z12 view in 358 ms instead of 1,081 ms (plain:
  228 ms).
- **PMTiles packs choose their tile group from the archive.** Without
  `--tile-group`, the packers use the smallest of 16, 32 and 64 KiB whose
  shards all fit in the descriptor's top meta, else 64 KiB, so every zoom
  band is listed there directly whenever the archive allows it. The old
  1 MiB default made a reader fetch a whole 1 MiB group around each tile:
  the Protomaps planet now gets 64 KiB, and a cold view downloads 21% more
  than plain PMTiles instead of 323% more. The budget used, chosen or
  explicit, is printed on stderr after the `proofs:` line (`tile group:
  65536 bytes`). An explicit `--tile-group N` (including `0`) is unchanged.
- Fragmented MP4s packed with `--profile auto` now get the `mp4` profile and
  new anchors; `--chunk` on such a file needs `--profile fixed`.
- **A zoom band too large for the top meta splits into small
  subdirectories** of at most 399 shards each (child metas of at most
  16 KiB), each listed in the top meta, their sizes differing by at most one
  shard: the first view into such a band waits on one small meta instead of
  a meta of up to 256 KiB. Only when the top meta has no room for them does
  the band become one nested subdirectory, as before.
- Packer CLI is strict: unknown flags, flags without a value, extra
  arguments, an unknown `--profile`, `--profile pmtiles` on a non-PMTiles
  file (previously a silent fixed pack), `--chunk` with the pmtiles profile,
  `--tile-group` with the fixed profile, and `--out` or `--full-car` naming
  the input file are errors instead of being ignored. The packer also
  refuses an `--out` directory that contains the input (`--out contains the
  input file`) and a `--full-car` whose `<path>.tmp` is the input.
- PMTiles directories and metadata may decompress to at most 256 MiB each
  (larger blocks fail as `PMTiles <codec> decompression failed`), and an
  archive may list at most 2^30 tile entries (`PMTiles has more than 2^30
  tile entries`), so a small hostile archive cannot exhaust memory.
- A zstd-compressed PMTiles directory or metadata block must be exactly one
  complete zstd frame: a truncated frame, a second or skippable frame, or
  trailing bytes now fail as `PMTiles zstd decompression failed`. Node 22
  ignored truncation and anything after the first frame, while Node 24
  rejects truncation, so the TS packer accepted different archives
  depending on the Node version. One zstd compression call writes one
  frame, so ordinary archives are unaffected.
- The top meta keeps one slot per remaining zoom band when inlining a band,
  so archives such as one band of 1,598 shards followed by a small band now
  pack (the large band moves into subdirectories) instead of failing with
  `top meta needs … entries`.
- `--full-car`: the `<path>.tmp` file is opened before the proof files are
  written; an open failure is still reported after them. Any later failure
  removes `<path>.tmp` before the error is reported.
- The packer also refuses an existing output that is the input file itself,
  reached through a symlink or a hard link (compared by device and inode):
  a proof file (`--out contains the input file`) or `<full-car>.tmp`
  (`--full-car resolves to the input file`). Nothing is written in that
  case, only the proof directories.
- `pack verify` reads proof files on demand instead of loading the whole
  `--proofs` directory, so unrelated entries (such as a dangling symlink) no
  longer fail it.
- PMTiles inputs must have tile lengths ≤ 0xffffffff and safe-integer tile
  ids. Decompression and metadata JSON failures report fixed messages
  (`PMTiles gzip decompression failed`, `PMTiles metadata is not valid
  JSON`, …) instead of library text.
- `--full-car` writes blocks in canonical DAG post-order (children left to
  right, then the parent; each block once), replacing the importer's
  internal put order. Only files over 174 chunks (> 43.5 MiB) get different
  CAR bytes; the DAG, its root CID and `ipfs dag import` results are
  unchanged. The CAR is written to `<path>.tmp` and renamed when complete.
- The proof directory's `root` is written last, so a present `root` means
  every file it names exists.
- `pack verify` prints `verify OK`, drops `--reads` (fixed at 64 spot
  reads), and rejects a file whose length differs from the descriptor's
  `mapSize`; a trailing byte previously passed.

### Fixed

- PMTiles archives whose metadata or leaf directories come after the tile
  data — the layout of the Protomaps planet builds — failed to pack with
  `tile leaf at … matches no tile group`. Those sections now form a last
  band of their own. Archives that packed before are unaffected.
- The TS packer failed with a stack overflow (`Maximum call stack size
  exceeded`) on a PMTiles leaf directory of more than ~125,000 entries.
- `pack assets` inlined every file up to the 8 MiB CAR section cap, so a
  typical directory's "proof" carried a complete second copy of the content
  (a 6.2 MB glyph directory emitted a 6.28 MB CAR for a 32 KB manifest),
  defeating lazy verification. Inlining is now all-or-nothing under a fixed
  256 KiB budget: a directory whose files total at most 256 KiB travels
  whole in the CAR — one fetch serves the bundle — and anything larger
  emits the manifest alone, so clients fetch content from `{base}/{path}`
  as specified. Anchors are unaffected: the anchor hashes the manifest
  block alone, so existing published anchors stay valid and only the bag
  shrinks.
- `examples/assets.html` pinned a pre-MASL dag-pb fonts anchor that
  `parseAssetAnchor` rejects, so the example failed against its own
  library. The fixture is regenerated with the shipped `packAssets` (the
  generator previously used a test helper), and `npm test` now runs
  `examples/build-assets.ts`, whose drift guard keeps page and fixture in
  sync.
- `pack assets` wrote one CAR section per file, so identical files produced
  duplicate sections and the client rejected the bundle. Each distinct
  block is now written once, and the 256 KiB inline budget counts unique
  bytes.
- `pack assets` took the extension from the whole path, so `dir.v2/LICENSE`
  got `v2/license`; it now comes from the file name. Names that are not
  valid UTF-8 are errors.
- `--chunk 0` looped forever; it is now an error, as is a size beyond 2^53.
- Large inputs no longer fail to pack: a top meta with over 1,598 entries
  (e.g. `--chunk 256KiB` on ~760 GB, or a planet with `--tile-group 0`)
  now moves the band into subdirectories listed in the top meta, and a
  shard closes early when a leaf offset would overflow its u32 relative
  offset (large `--chunk` on large files).

### Notes

- Every ranged-file anchor changes, because `root` carries the BLAKE3 `map`.
  For every file that packed before, all other proof files are
  byte-identical to v0.4, except PMTiles archives packed with the default
  `--tile-group` (now chosen per file) and files with a band of more than
  1,598 shards (now split). Full CAR bytes differ only for files over 174
  chunks, and bundle CARs only for directories with duplicate files. Asset
  anchors are unaffected, except that a bundle anchor changes when `--type
  .=…` now types a dotless file under a dotted directory.
- A page pinned to `veritiles@0.4` keeps the v0.4 client, which reads only
  v0.4 packs: re-pack its data before moving it to `@0.5`.

## [0.4.0] — Routing hints

**Routing hints** separate _where_ from _what_: an untrusted `hints.json`
beside the page (or beside the data) maps CIDs to candidate locations, so hosts
can move — or pages can ship anchor-only — without touching a verified byte.
The layer is fully optional: a configured client never fetches a hint, wrong
hints waste a request at worst, and every byte still verifies against the
anchor.

### Added

- **Routing hints** ([`SPEC.md` §5](https://github.com/anymirror-dev/anymirror/blob/v0.4.0/SPEC.md#5-routing-hints)): an untrusted `hints.json` maps CIDs to
  candidate locations, so a page can ship only its anchor and keep host
  locations in a sibling file that changes on its own cadence. Every byte
  fetched through a hint is still verified against the anchor exactly as a
  configured URL is. One new option on `VerifiedSource` / `VerifiedFile` /
  `VerifiedAsset`: `hints` (`string | string[]`) — document URL(s), defaulting
  to `./hints.json` beside the page, fetched lazily only when a location is
  missing. Relative URLs inside a document resolve against the document's own
  URL — the final URL after redirects — so a copied or redirected hints file
  is correct on any mirror. Document bodies are bounded to a fixed 1 MiB
  pre-parse.
- Tolerant hints parser: salvages every valid entry and ignores malformed
  keys, values, and URLs individually; only a non-object body or the size cap
  rejects a whole document.
- In-directory discovery: the directory holding published artifacts — a proof
  base, a bundle base, or the directory containing a proof CAR or content
  file — may publish `hints.json`, probed only when a location class is
  missing (location → document → location, bounded by a 16-document-per-client
  cap).
- `examples/hints.html` — an anchor-only page backed by a sibling
  `hints.json`.

### Changed

- `source` is now optional on `VerifiedFile` / `VerifiedAsset`: a hints
  document may supply the location. Every location option (`source`, `proof`,
  `hints`) is optional; a fully configured client fetches zero hint documents.
- A query-string source no longer requires an explicit `proof` when an
  explicit hints document supplies the proof location; the defaulted document
  never lifts that requirement.
- Hints faults are transport-level — they never increment `rejected` and never
  ban a source; a hinted URL, once merged, is an ordinary source under the
  existing failover, ban, and speculative-range rules.
- The routing-hints specification lands in `SPEC.md` as **§5 Routing hints**;
  the previous §5–§8 (Hosts, Publishing, IPFS interoperability, Non-goals)
  are renumbered §6–§9.

### Notes

- No breaking changes: the descriptor, shard-tree, and MASL formats are
  unchanged, and every existing API keeps its signature and behavior.

## [0.3.1] — UnixFS bridge

### Added

- Optional UnixFS/IPFS bridge for `VerifiedFile` packs: `npm run pack --
--unixfs` embeds a reproducible UnixFS root CID (the standard
  `ipfs add --cid-version 1` layout) in the descriptor, and `--full-car
<path>` also writes that DAG as a CAR for `ipfs dag import` and pinning
  services. Purely additive — the map CID and proof tree are unchanged.

### Changed

- `SPEC.md` condensed and reorganized as a tighter, DASL/MASL-aligned
  specification (CIDs restricted to raw/dag-cbor, clearer ranged-file vs.
  asset separation, streamlined client-behavior and host sections). No
  behavioral changes to the formats.

### Fixed

- README: the `VerifiedAsset` options list matches the shipped API (a stray
  `checkProofCompleteness` mention removed); the packer is documented as a
  repository development tool (clone + `npm ci`), not part of the published
  npm package.

## [0.3.0] — DASL compatibility

### Added

- `VerifiedFile`: a general-purpose range-verified file reader for any large
  file, not just PMTiles; `VerifiedSource` is now a thin pmtiles adapter over
  it.
- `npm run pack` CLI (`tools/pack.ts`): generates the descriptor + proof tree
  for a file (`fixed` and `pmtiles` publisher profiles, with zoom-shaped proof
  trees for PMTiles archives), plus a `pack assets` subcommand for MASL
  bundles.
- `VerifiedAsset.stat()`: returns `{ size, contentType? }` for a manifest
  entry.

### Changed

- **Breaking:** new range-proof format — a dag-cbor descriptor
  (`{proof}/root`) plus a tree of binary meta/shard files replaces the
  CARv1-based map package; the anchor CID codec changes from `dag-pb` to
  `dag-cbor`, and the `metadata.json` bootstrap manifest is gone. Old packages
  and their root CIDs are incompatible.
- **Breaking:** `VerifiedAsset` proofs move to MASL — a dag-cbor manifest
  bundle (raw content CIDs + a MASL-style resources map) read as an untrusted
  bag of blocks and verified lazily on first use; the old strict-CARv1/UnixFS
  DAG-walking proof and its `car` anchors are retired.
- **Breaking:** `rootCid` option renamed to `cid` across the public API;
  `source` now points at the file itself (proofs default to
  `{source}.proofs`), not a package directory.
- `SPEC.md` rewritten around the descriptor/shard-tree and MASL-CAR proof
  systems; README updated with the new API and host requirements.

### Notes

- The previously hosted demo package predates this proof format and does not
  verify until republished.

## [0.2.0] — Verified assets

### Added

- `VerifiedAsset`: verified whole-file assets — a raw single file or a
  CARv1/UnixFS bundle resolved by path — with `assetProtocol`, a MapLibre
  `verified://<anchor>/<path>` protocol handler, and a fonts/style example
  (`examples/assets.html`).
- `SPEC.md`: the verification formats unified into a single document.

### Changed

- Examples load the veritiles browser bundle from a CDN by default, so they
  run without a local build.

## [0.1.0] — Verified PMTiles

### Added

- Initial release: `VerifiedSource`, a pmtiles-compatible `Source` that
  fetches PMTiles byte ranges from any dumb HTTP host and verifies every byte
  against a content-addressed anchor (IPFS CID) before the map renders it —
  with failover across mirrors, tamper bans, and verified-byte caching.
  Examples for MapLibre GL, Leaflet, and OpenLayers.

[0.6.1]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.6.1
[0.6.0]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.6.0
[0.5.0]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.5.0
[0.4.0]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.4.0
[0.3.1]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.3.1
[0.3.0]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.3.0
[0.2.0]: https://github.com/anymirror-dev/anymirror/releases/tag/v0.2.0
[0.1.0]: https://github.com/anymirror-dev/anymirror/commit/dce0f1318101a128e3fabc5dc86620b6b4041e36
