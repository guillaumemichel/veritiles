# veritiles

Verified map tiles for [PMTiles](https://protomaps.com/): a drop-in
`Source` that fetches tile byte ranges from **any dumb HTTP host** and
**cryptographically verifies every byte** against a single
self-certifying content identifier
([CID](https://docs.ipfs.tech/concepts/content-addressing/)) before your
map renders it.

The host is untrusted: a CDN, an S3 bucket, GitHub Pages, an IPFS gateway,
or `python -m http.server` — anything answering `GET` with single-`Range`
`206` responses. A malicious or compromised host can withhold tiles
(visible), but cannot alter one undetected: tampered bytes fail
verification, are counted, and are never rendered. With more than one
source configured, a bad host is skipped for the next.

- **Zero dependencies** — ~15 KB minified, including the CID and dag-pb
  handling.
- **Zero per-tile overhead** — a warm tile read is one exact `Range`
  request, the same bytes an unverified client would fetch; proofs are
  ≈ 0.24 % of the archive, fetched lazily for browsed regions only.
- **One round trip for cold tiles** — tile data is fetched speculatively in
  parallel with the proof descent and adopted after its hash checks out.
- **Works with every PMTiles renderer** — MapLibre GL, Leaflet (vector and
  raster), OpenLayers — because it implements the standard `pmtiles`
  [`Source`](https://github.com/protomaps/PMTiles/blob/main/js/src/index.ts)
  interface.

```js
const source = new veritiles.VerifiedSource({
  rootCid: 'bafybei…',                    // the only trust anchor
  source: 'https://tiles.example/world',  // untrusted base URL(s) of the package
});
```

## Install

```sh
npm install veritiles
```

or from a CDN as a script tag (exposes the `veritiles` global):

```html
<script src="https://unpkg.com/veritiles@0.1.0/dist/veritiles.js"></script>
```

## Usage

### MapLibre GL

```html
<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js"></script>
<script src="https://unpkg.com/veritiles@0.1.0/dist/veritiles.js"></script>
<script>
  const rootCid = 'bafybeidromswvzgmm4hwagh6yn3ktbf2wajgfmt3zcqkt4oofmqw4wfkja';
  const source = new veritiles.VerifiedSource({
    rootCid,
    source: `https://guillaumemichel.github.io/ipfs-pmtiles-demo/ipfs/${rootCid}`,
  });

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocol.add(new pmtiles.PMTiles(source)); // register BEFORE the style loads

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        verified: {
          type: 'vector',
          url: 'pmtiles://' + rootCid,
          attribution: '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [ /* … */ ],
    },
  });
</script>
```

The style URL is `pmtiles://<rootCid>` — the protocol resolves it to the
registered instance by key, so nothing is ever fetched from that URL.

### Leaflet

Vector tiles, via [protomaps-leaflet](https://github.com/protomaps/protomaps-leaflet)
(its `url` option accepts a `PMTiles` instance):

```js
import { PMTiles } from 'pmtiles';
import { leafletLayer } from 'protomaps-leaflet';
import { VerifiedSource } from 'veritiles';

const layer = leafletLayer({
  url: new PMTiles(new VerifiedSource({ rootCid, source: baseUrl })),
  flavor: 'light',
});
layer.addTo(map);
```

Raster tiles, via the `pmtiles` package's own Leaflet adapter:

```js
import { PMTiles, leafletRasterLayer } from 'pmtiles';

leafletRasterLayer(
  new PMTiles(new VerifiedSource({ rootCid, source: baseUrl })),
  { attribution: '…' },
).addTo(map);
```

### OpenLayers

[ol-pmtiles](https://github.com/protomaps/PMTiles/tree/main/openlayers)
accepts a raw pmtiles `Source` as its `url` option:

```js
import { PMTilesVectorSource } from 'ol-pmtiles';
import { VerifiedSource } from 'veritiles';

const source = new PMTilesVectorSource({
  url: new VerifiedSource({ rootCid, source: baseUrl }),
});
```

## API

### `new VerifiedSource(options)`

| option          | type                 | required | description                                                                                                              |
| --------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `rootCid`       | `string`             | yes      | Root CID of the map package (CIDv1, base32, dag-pb + sha2-256). The **only** trust input.                                 |
| `source`        | `string \| string[]` | yes      | Base URL(s) of the package — the directory containing `metadata.json` — tried in order. Relative URLs resolve to the page. |
| `fetchFn`       | `typeof fetch`       | no       | Replaces global `fetch` — instrumentation/test seam.                                                                      |
| `maxCacheBytes` | `number`             | no       | Budget for the verified-byte LRU cache (default 64 MiB).                                                                   |

Construction is synchronous and validates the CID; the first read performs
the trust bootstrap (one `metadata.json` fetch, authenticated by
reconstructing the root CID from it). A failed bootstrap is retried on the
next read.

**Methods** — the pmtiles `Source` contract plus two extras:

- `getBytes(offset, length, signal?)` → `Promise<{ data: ArrayBuffer }>` —
  verified bytes, clamped at EOF.
- `getKey()` → the root CID (the `pmtiles://<key>` style key).
- `ready()` → `Promise<void>` — optional eager bootstrap, to surface a bad
  CID or unreachable host before the map goes up.
- `stats` → `{ verified, rejected }` — hash checks passed / tampered
  responses caught so far (drive a UI badge from this).

**Errors** — all fail closed; a rejected read surfaces through the map
library's error event:

- `VerificationError` — bytes did not match the committed digest.
- `RangeUnsupportedError` — the host answered `200` to a `Range` request
  (it would stream the whole archive per tile).
- `RangeBlockedError` — the browser blocked cross-origin `Range` requests
  (CORS preflight; see below).

## Host requirements

| requirement                                     | why                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET <base>/<path>`                             | package contents: `metadata.json`, `map.pmtiles`, `proofs/…`                                             |
| Single `Range: bytes=a-b` → `206`, exact bytes  | tile reads; identity encoding (no transparent compression of ranged responses)                           |
| HTTPS or localhost                              | WebCrypto requires a secure context                                                                      |
| CORS `Access-Control-Allow-Origin: *`           | cross-origin embedding only; Firefox additionally preflights `Range`, so answer `OPTIONS` allowing it    |

The package can live at **any URL** — a bucket root, a subdirectory, a
page-relative path. The URL carries **no trust**: verification uses only
the configured `rootCid`, so a wrong or malicious source merely fails
verification and the next one is tried.

### IPFS interop (optional)

The trust anchor is a standard IPFS CID, so the same package is natively
IPFS-publishable with no extra work: pin it to any node and every
range-capable gateway becomes a conforming source
(`source: 'https://dweb.link/ipfs/<rootCid>'`, or a local
[Kubo](https://github.com/ipfs/kubo) gateway). Publishers who mirror onto
static hosts under an `/ipfs/<rootCid>/` path keep their URLs recognizable
to IPFS tooling (e.g. IPFS Companion can redirect them to a local
gateway), but that layout is a convention, not a requirement.

## Creating verified map packages

A package is a plain directory — `map.pmtiles`, `metadata.json`, and a
`proofs/` tree — identified by one root CID, published by copying it
anywhere on any static host and/or pinning it to IPFS.

Packaging tooling is not part of this library yet. For now, the format and
client protocol are specified in the
[ipfs-pmtiles-demo](https://github.com/guillaumemichel/ipfs-pmtiles-demo)
repository's
[SPEC.md](https://github.com/guillaumemichel/ipfs-pmtiles-demo/blob/main/SPEC.md),
alongside the reference build pipeline (PMTiles archive in, package + CAR
file out) and a
[live demo](https://guillaumemichel.github.io/ipfs-pmtiles-demo/) of this
verification client (try `?tamper=1`). Future work is to move the spec and
a packaging CLI into this repository, so the format is defined where its
client lives.

## Development

```sh
npm ci
npm test           # 104 tests: unit, golden fixtures from a real package,
                   # end-to-end through the real pmtiles reader
npm run typecheck
npm run build      # dist/: ESM bundle, minified IIFE, .d.ts
```

The library is zero-dependency by design; the canonical IPLD
implementations (`multiformats`, `@ipld/dag-pb`) and `pmtiles` appear only
as dev-dependencies, cross-validating the hand-rolled CID/dag-pb encoding
byte-for-byte in the test suite.

## License

[MIT](LICENSE)
