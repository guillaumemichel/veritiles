# veritiles

Verified content for [PMTiles](https://protomaps.com/) and any file: a drop-in
`Source` that fetches byte ranges from **any dumb HTTP host** and
**cryptographically verifies every byte** against a single trust anchor (a
[CID](https://docs.ipfs.tech/concepts/content-addressing/)) before your map
renders it.

The host is untrusted: a CDN, an S3 bucket, GitHub Pages, or `npx serve` —
anything answering `GET` with single-`Range` `206` responses. A malicious or
compromised host can withhold bytes (visible), but cannot alter one undetected:
tampered bytes fail verification, are counted, and are never rendered. With
more than one source configured, a bad host is skipped for the next.

The integrity proof is a small directory of static files: a tiny **descriptor**
(the anchor's block) plus a tree of digest files. The client downloads only the
pieces covering what it reads — a tile fetch costs at most a couple of small
proof files, even for a planet-size archive — and verifies every byte against
the sha2-256 chain rooted in the anchor (see [`SPEC.md`](./SPEC.md)).

- **Zero dependencies** — ~30 KB minified, including CID, DRISL/CBOR, and
  CAR handling. WebCrypto is the only cryptography.
- **Zero per-tile overhead** — a warm tile read is one exact `Range`
  request, the same bytes an unverified client would fetch.
- **One round trip for cold tiles** — tile data is fetched speculatively in
  parallel with the proof descent and adopted after its hash checks out.
- **Scales to planet** — proofs are offset-addressable: constant-size
  pieces, no upfront download, no index. First paint costs one descriptor
  (a few KB) plus the covering pieces.
- **Lazy verification** — opening a file hashes exactly one block (the
  descriptor, against the anchor); everything else verifies on first use.
- **Works with every PMTiles renderer** — MapLibre GL, Leaflet (vector and
  raster), OpenLayers — via the standard `pmtiles`
  [`Source`](https://github.com/protomaps/PMTiles/blob/main/js/src/index.ts)
  interface.

```js
const source = new veritiles.VerifiedSource({
  cid: "bafyrei…", // the proof descriptor's CID — the only trust anchor
  source: "https://tiles.example/world.pmtiles", // untrusted URL(s) of the file
  // proof defaults to `${source}.proofs`
});
```

## Install

```sh
npm install veritiles
```

or from a CDN as a script tag (exposes the `veritiles` global):

```html
<script src="https://unpkg.com/veritiles@0.4/dist/veritiles.js"></script>
```

## Usage

### MapLibre GL

```html
<script src="https://unpkg.com/maplibre-gl@6.2.0/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js"></script>
<script src="https://unpkg.com/veritiles@0.4/dist/veritiles.js"></script>
<script>
  const cid = "bafyrei…"; // the proof descriptor's CID — printed by `npm run pack`
  const source = new veritiles.VerifiedSource({
    cid,
    source: "https://tiles.example/world.pmtiles",
  });

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocol.add(new pmtiles.PMTiles(source)); // register BEFORE the style loads

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        verified: { type: "vector", url: "pmtiles://" + cid },
      },
      layers: [
        /* … */
      ],
    },
  });
</script>
```

The style URL is `pmtiles://<cid>` — the protocol resolves it to the
registered instance by key, so nothing is ever fetched from that URL.

### Leaflet

```js
import { PMTiles } from "pmtiles";
import { leafletLayer } from "protomaps-leaflet";
import { VerifiedSource } from "veritiles";

const layer = leafletLayer({
  url: new PMTiles(new VerifiedSource({ cid, source: fileUrl })),
  flavor: "light",
});
layer.addTo(map);
```

Raster tiles use the `pmtiles` package's own adapter
(`leafletRasterLayer(new PMTiles(new VerifiedSource({ cid, source })))`).

### OpenLayers

```js
import { PMTilesVectorSource } from "ol-pmtiles";
import { VerifiedSource } from "veritiles";

const source = new PMTilesVectorSource({
  url: new VerifiedSource({ cid, source: fileUrl }),
});
```

## API

### `new VerifiedSource(options)` / `new VerifiedFile(options)`

`VerifiedSource` is the pmtiles adapter; `VerifiedFile` is the same thing
without the pmtiles `Source` shape (`read(offset, length)` → `Uint8Array`).
Both take:

| option          | type                 | required | description                                                                                                                                                                                                                   |
| --------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cid`           | `string`             | yes      | The anchor CID (CIDv1, base32, sha2-256), codec `dag-cbor` — the proof descriptor.                                                                                                                                            |
| `source`        | `string \| string[]` | no       | URL(s) of the file itself, tried in order. Range + `206` required. Optional if a hints document supplies the location.                                                                                                        |
| `proof`         | `string \| string[]` | no       | Proof base URL(s) — the directory holding `root` and the proof tree. Default `${source}.proofs`. Required explicitly if a source has a query.                                                                                 |
| `hints`         | `string \| string[]` | no       | Routing-hints document URL(s), untrusted (`SPEC.md` §5). An explicit value is always consulted; its URLs join failover after configured ones. The default (`./hints.json` beside the page) is consulted only when a location is missing. Every hinted byte is verified against the anchor exactly as a configured one. |
| `fetchFn`       | `typeof fetch`       | no       | Replaces global `fetch` — instrumentation/test seam.                                                                                                                                                                          |
| `maxCacheBytes` | `number`             | no       | Budget for the verified-byte LRU cache (default 64 MiB).                                                                                                                                                                      |

Construction is synchronous and validates the CID; the first read resolves
locations (configured, then hinted) and fetches `{proof}/root`, hashing it
against the anchor — after that, every proof file and content slice is verified
against the digest its parent committed. A failed open is retried on the next
read.

```js
// Ship only the anchor; put world's location in a sibling hints.json.
const source = new veritiles.VerifiedSource({ cid: "bafyrei…" });
```

with, beside the page, `hints.json`:

```json
{
  "hints": {
    "bafyrei…desc": ["https://node.example/world.pmtiles.proofs"],
    "bafkrei…file": ["https://cdn-a.example/world.pmtiles", "https://cdn-b.example/world.pmtiles"]
  }
}
```

Identity lives in the page (the `cid`), location lives in `hints.json` — each
changes on its own cadence, and moving hosts is an edit to one JSON file.

**Methods** (`VerifiedSource`, the pmtiles `Source` contract plus extras):

- `getBytes(offset, length, signal?)` → `Promise<{ data: ArrayBuffer }>` —
  verified bytes, clamped at EOF.
- `getKey()` → the anchor CID (the `pmtiles://<key>` style key).
- `ready()` → `Promise<void>` — optional eager open, to surface a bad CID or
  unreachable host before the map goes up.
- `stats` → `{ verified, rejected }` — hash checks passed / tampered
  responses caught so far (drive a UI badge from this).

**Errors** — all fail closed: `VerificationError` (bytes did not match the
committed digest), `RangeUnsupportedError` (the host answered `200` to a
`Range` request), `RangeBlockedError` (the browser blocked cross-origin
`Range`; answer `OPTIONS`).

## Host requirements

| requirement                                    | why                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET <file>` and `GET <file>.proofs/*`         | the archive and its proof files (plain GETs — **no `Range` needed for proofs**)                       |
| Single `Range: bytes=a-b` → `206`, exact bytes | tile reads; identity encoding (no transparent compression of ranged responses)                        |
| HTTPS or localhost                             | WebCrypto requires a secure context                                                                   |
| CORS `Access-Control-Allow-Origin: *`          | cross-origin embedding only; Firefox additionally preflights `Range`, so answer `OPTIONS` allowing it |

The file can live at **any URL**. The URL carries **no trust**: verification
uses only the configured `cid`, so a wrong or malicious source merely fails
verification and the next one is tried. Publishing is `cp -r map.pmtiles
map.pmtiles.proofs <host>`; mirroring is `rsync`.

### First paint and proof size

Proofs are fetched **incrementally, in constant-size pieces**: the
descriptor (a few KB, holding the top-level digest map) plus only the
pieces covering what you read — each ≤ 64 KiB, proving ~1,820 consecutive
leaves. There is no upfront proof download and no index, at any archive
size:

| content                      | cold first paint             | steady state        |
| ---------------------------- | ---------------------------- | ------------------- |
| 120 MB city, per-tile cuts   | descriptor + 1–2 proof files | 1 `Range` per tile  |
| 120 GB planet, per-tile cuts | descriptor + 2–3 proof files | 1 `Range` per tile  |
| 2 GB video, 1 MiB chunks     | descriptor + 1 proof file    | 1 `Range` per chunk |

Proof pieces are immutable and cached by digest forever, so after warm-up
every tile read is one exact `Range` request with zero overhead. The total
proof size is ~37 bytes per leaf — but you never fetch all of it.

### IPFS compatibility (optional)

No IPFS anywhere is required — a dumb static host is the normative
mechanism. Use `--unixfs` while packing to embed a reproducible UnixFS root
CID (the standard 256 KiB fixed-chunk `ipfs add --cid-version 1` layout).
Then pin the emitted `--full-car` output, or import it with `ipfs dag import`;
a gateway holding that DAG is a valid configured _content_ source. The client
continues to verify gateway range responses against the veritiles proof tree.

## Verified assets

Everything else a map needs — a **style**, a **sprite** set, **font
glyphs**, any directory tree — is a _whole-file_ resource rather than a
range read. `VerifiedAsset` fetches these from dumb HTTP hosts and verifies
them against the content's own root CID, exactly as `VerifiedSource` does
for tiles. The anchor's codec says what it names:

- **raw anchor** (`bafkrei…`) — a single file ≤ 256 KiB (a typical
  `style.json`). The content is self-verifying; no proof exists.
- **dag-cbor anchor** (`bafyrei…`) — a strict MASL bundle. Its CAR contains
  the authenticated manifest and may include small raw files; every resource
  maps a path to a raw whole-file CID and declared size.

```js
import { VerifiedAsset, assetProtocol } from "veritiles";

// A directory of glyphs; the proof defaults to `<base>.car`.
const fonts = new VerifiedAsset({ cid: FONTS_CID, source: fontsBase });

// A sprite whose proof is hosted somewhere else entirely.
const sprite = new VerifiedAsset({
  cid: SPRITE_CID,
  source: spriteBase, // dumb mirror: content only
  proof: "https://cdn.example/sprite.car", // proof hosted elsewhere
});

maplibregl.addProtocol("verified", assetProtocol([fonts, sprite]));

// A raw style artifact — its own bytes are the trust input.
const style = new VerifiedAsset({ cid: STYLE_CID, source: styleUrl });
const map = new maplibregl.Map({
  container: "map",
  style: JSON.parse(new TextDecoder().decode(await style.bytes(""))),
});
```

with, inside the verified `style.json`:

```json
{
  "glyphs": "verified://<fonts CID>/{fontstack}/{range}.pbf",
  "sprite": "verified://<sprite CID>/sprite"
}
```

A `verified://<cid>/<path>` URL carries the **trust anchor, never the
location**: the registry maps the anchor to a client instance whose URLs
come from page configuration, so styles stay host-independent and are
themselves pinnable artifacts.

`VerifiedAsset` options are `cid`, `source`, `proof`, `fetchFn`,
`maxCacheBytes`, `maxProofBytes`, and `maxFileBytes`. `bytes(path?,
{ signal? })` returns the file at `path` (`''`, the default, is the artifact
itself), a fresh copy each call. `NotFoundError` is an **authenticated
absence** — the artifact provably lacks that path (distinct from a host's
HTTP 404); the `assetProtocol` adapter turns a `NotFound` glyph range into
an empty response and surfaces every other error. Asset hosts need only
HTTPS and `Access-Control-Allow-Origin: *` — reads are whole-file `GET`s, so
**no `Range` support is required**.

## Creating verified content

The packer is a repository development tool, not part of the published
`veritiles` npm package. Clone this repository and install its development
dependencies before running it:

```sh
git clone https://github.com/guillaumemichel/veritiles.git
cd veritiles
npm ci
```

```sh
npm run pack -- map.pmtiles
# → writes map.pmtiles.proofs/  (descriptor + proof tree)
# → prints the anchor CID (bafyrei…) to stdout

# Optional IPFS bridge for the same archive:
npm run pack -- map.pmtiles --unixfs --full-car map.car
# → prints a descriptor anchor and its UnixFS CID
# → writes map.car for `ipfs dag import` / pinning

# A verified path-addressed asset bundle:
npm run pack -- assets ./public --out assets.car
```

Upload `map.pmtiles` and `map.pmtiles.proofs/` to any static host and
configure clients with the printed anchor. The packer cuts chunk
boundaries at the ranges a pmtiles reader actually requests — one leaf per
tile or tile group, zero over-fetch — and shapes the proof tree by zoom
level, so low zooms stay shallow and the descriptor stays tiny at any
scale. The generator profiles are documented in [`SPEC.md`](./SPEC.md) §7;
`--profile fixed` packs non-PMTiles files. The reference application
(PMTiles archive → verified map) lives in the
[ipfs-pmtiles-demo](https://github.com/guillaumemichel/ipfs-pmtiles-demo)
repository, alongside a
[live demo](https://guillaumemichel.github.io/ipfs-pmtiles-demo/) of this
verification client (try `?tamper=1`).

## Development

```sh
npm ci
npm test           # unit + differential tests, kubo-verified golden anchors,
                   # end-to-end through the real pmtiles reader
npm run typecheck
npm run build      # dist/: ESM bundle, minified IIFE (~30 KB), .d.ts
```

The library is zero-dependency by design. Canonical IPLD implementations
(`multiformats`, `@ipld/dag-cbor`, `@ipld/dag-pb`, `@ipld/car`,
`ipfs-unixfs-importer`, `blockstore-core`) and `pmtiles` are dev-dependencies
only. They cross-check CID, DRISL/MASL, CAR, and optional UnixFS publishing
output in the test suite.

## License

[MIT](LICENSE)
