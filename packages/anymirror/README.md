# anymirror

Verified content from any mirror. anymirror's readers fetch files from
**untrusted HTTP hosts** — a CDN, an S3 bucket, GitHub Pages, `npx serve` —
and **verify every byte** against a single trust anchor (a
[CID](https://dasl.ing/cid.html)) before handing it over. A host can withhold
bytes, but cannot alter one undetected: a tampered response fails
verification, is counted, and the next host is tried.

One reader per shape of content, each behind its own entry point, so a page
carries only the code it runs:

| entry point        | reader           | reads                                                         | gzipped |
| ------------------ | ---------------- | ------------------------------------------------------------- | ------- |
| `anymirror/file`   | `VerifiedFile`   | one large file, such as PMTiles or a video, by byte ranges    | 8.5 KB  |
| `anymirror/raw`    | `VerifiedRaw`    | one small file, at most 256 KiB, whole                        | 4.4 KB  |
| `anymirror/bundle` | `VerifiedBundle` | files by path from a MASL bundle: glyphs, sprites, a site     | 6.8 KB  |
| `anymirror/hints`  | `hints`          | the hints plugin: where a CID lives, from documents (below)   | +1.2 KB |

`anymirror` itself exports them all. It has no dependencies beyond its
[router contract](https://github.com/anymirror-dev/anymirror/tree/main/packages/router),
which holds no code; WebCrypto is the only cryptography. For maps, use
[veritiles](https://github.com/anymirror-dev/anymirror/tree/main/packages/veritiles),
built on these readers.

## Install

```sh
npm install anymirror
```

## Reading

### A large file, by ranges

```js
import { VerifiedFile } from "anymirror/file";

const file = new VerifiedFile({
  cid: "bafyrei…", // the proof descriptor's CID: the only trust anchor
  source: "https://cdn.example/video.mp4", // untrusted URL(s) of the file
  // proof defaults to `${source}.proofs`
});
const bytes = await file.read(0, 65536); // verified bytes, clamped at the end
```

`read(offset, length, { signal })` resolves to verified bytes, a fresh copy
each call. `ready()` opens the file eagerly, `size` is its length once open,
and `stats` counts the hash checks passed and the tampered responses caught
(`{ verified, rejected }`). The proof is a small directory of static files: a
descriptor, which the anchor names, and a tree of digests, fetched piece by
piece as reads need them. A warm read is one exact `Range` request.

### One small file

```js
import { VerifiedRaw } from "anymirror/raw";

const style = new VerifiedRaw({
  cid: "bafkrei…", // the raw CID of the file: the sha2-256 of its bytes
  source: "https://cdn.example/style.json",
});
const bytes = await style.bytes(); // hashed against the CID before it resolves
```

A raw file needs no proof: its CID is its hash. `ipfs add --cid-version 1`
prints it for a file of at most 256 KiB.

### A bundle of files

```js
import { NotFoundError, VerifiedBundle } from "anymirror/bundle";

const fonts = new VerifiedBundle({
  cid: "bafyrei…", // the bundle's manifest
  source: "https://cdn.example/fonts", // files at `${source}/${path}`
  // proof defaults to `${source}.car`
});
const glyphs = await fonts.bytes("Noto Sans Regular/0-255.pbf");
const { size, contentType } = await fonts.stat("Noto Sans Regular/0-255.pbf");
```

The manifest maps each path to the CID and size of its file, and each file
is checked against its CID. `NotFoundError` is an **authenticated absence**:
the bundle provably lacks that path, unlike a host's HTTP 404. A small bundle
travels whole in its CAR, so one fetch serves every file.

An anchor's codec says which reader it needs: `assetKind(cid)`, from
`anymirror`, answers `'raw'` or `'bundle'`.

## Locations

The anchor is the only trust input; locations carry none. Every reader takes:

| option          | type                 | description                                                                                                                                               |
| --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cid`           | `string`             | The anchor (CIDv1, base32, sha2-256).                                                                                                                     |
| `source`        | `string \| string[]` | URL(s) of the content, tried in order. Optional if hints or a router supply them.                                                                        |
| `hints`         | `Hints`              | Hints documents and discovery, untrusted: `hints()` from `anymirror/hints`. Off unless passed.                                                            |
| `router`        | `Router \| locate`   | A router, untrusted: yields where a CID's bytes may live, in place of the built-in router, whose locations it gets as `defaults`. May carry every request. |
| `fetchFn`       | `typeof fetch`       | Replaces the global `fetch`: instrumentation, credentials, tests.                                                                                         |
| `maxCacheBytes` | `number`             | Budget for the verified-byte cache (default 64 MiB).                                                                                                      |

`VerifiedFile` and `VerifiedBundle` also take `proof`, the URL(s) of their
proof; `VerifiedBundle` takes `maxProofBytes` and `maxFileBytes`, bounds on a
proof and a file.

With the hints plugin, a page can ship anchors alone and keep their locations
in a JSON file beside it, which changes when hosts move:

```js
import { VerifiedFile } from "anymirror/file";
import { hints } from "anymirror/hints";

const file = new VerifiedFile({ cid: "bafyrei…", hints: hints() }); // reads ./hints.json
```

`hints(url)` names the documents instead. A router finds locations at run
time, from an index, a gateway or a lookup table:
[`@anymirror/router`](https://github.com/anymirror-dev/anymirror/tree/main/packages/router)
describes the contract, and `@anymirror/fisl-router` reads a
[FISL](https://dasl.ing/fisl.html) index. Whatever names a location, every
byte fetched from it verifies against the anchor, so a wrong location costs a
request, never a wrong byte.

## Errors

All fail closed. `VerificationError`: bytes did not match the digest their
anchor commits to. `RangeUnsupportedError`: a host answered `200` to a
`Range` request. `RangeBlockedError`: the browser blocked a cross-origin
`Range` request; the host must answer `OPTIONS`. `NotFoundError`: a bundle
lacks the path.

## Hosts

| requirement                                    | needed by                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`                                          | every reader: content, proof files, bundle files                             |
| Single `Range: bytes=a-b` → `206`, exact bytes | `VerifiedFile` content only, in identity encoding                            |
| HTTPS or localhost                             | every reader: WebCrypto needs a secure context                               |
| CORS `Access-Control-Allow-Origin: *`          | cross-origin pages; Firefox also preflights `Range`, so answer `OPTIONS` too |

Publishing is `cp` to any static host; mirroring is `rsync`.

## Creating verified content

Publishers pack with `anymirror-pack`, a Rust command line tool, which needs
Rust and a C compiler:

```sh
git clone https://github.com/anymirror-dev/anymirror.git
cargo install --path anymirror/packer   # installs anymirror-pack
```

```sh
anymirror-pack video.mp4
# → writes video.mp4.proofs/ (descriptor + proof tree)
# → prints the anchor CID (bafyrei…)

anymirror-pack assets ./public --out public.car
# → writes the bundle's CAR and public.masl, its manifest alone
# → prints the anchor CID (bafyrei…)

anymirror-pack verify --cid bafyrei… --file video.mp4 --proofs video.mp4.proofs
# → prints `verify OK`
```

It cuts a PMTiles archive at the ranges its readers request, a fragmented
MP4 at its fragments, and any other file into fixed-size leaves (`--chunk`,
default 1 MiB). It reads local files of any size with bounded memory.
`--unixfs --full-car file.car` also derives a UnixFS root CID and writes a
CAR an IPFS node can import, so a gateway can serve the same bytes.

## Specification

[`SPEC.md`](https://github.com/anymirror-dev/anymirror/blob/main/SPEC.md)
defines the anchors, the proof formats, what a reader must check, and
routers.

## License

[MIT](LICENSE)
