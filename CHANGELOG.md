# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor = feature, patch =
fix).

## [0.4.0]

### Added

- **Routing hints** (`SPEC.md` §5): an untrusted `hints.json` maps CIDs to
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

## [0.3.1]

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

## [0.3.0]

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

## [0.2.0]

### Added

- `VerifiedAsset`: verified whole-file assets — a raw single file or a
  CARv1/UnixFS bundle resolved by path — with `assetProtocol`, a MapLibre
  `verified://<anchor>/<path>` protocol handler, and a fonts/style example
  (`examples/assets.html`).
- `SPEC.md`: the verification formats unified into a single document.

### Changed

- Examples load the veritiles browser bundle from a CDN by default, so they
  run without a local build.

## [0.1.0]

### Added

- Initial release: `VerifiedSource`, a pmtiles-compatible `Source` that
  fetches PMTiles byte ranges from any dumb HTTP host and verifies every byte
  against a content-addressed anchor (IPFS CID) before the map renders it —
  with failover across mirrors, tamper bans, and verified-byte caching.
  Examples for MapLibre GL, Leaflet, and OpenLayers.

[0.4.0]: https://github.com/guillaumemichel/veritiles/releases/tag/v0.4.0
[0.3.1]: https://github.com/guillaumemichel/veritiles/releases/tag/v0.3.1
[0.3.0]: https://github.com/guillaumemichel/veritiles/releases/tag/v0.3.0
[0.2.0]: https://github.com/guillaumemichel/veritiles/releases/tag/v0.2.0
[0.1.0]: https://github.com/guillaumemichel/veritiles/commit/dce0f1318101a128e3fabc5dc86620b6b4041e36
