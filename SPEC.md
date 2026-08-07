# veritiles — Verified Content over Dumb Hosts

veritiles verifies content fetched from untrusted static hosts. The only trust
input is a CID anchor. A host may withhold bytes, but cannot alter a byte that
passes verification.

| client | content shape | reads | authenticated format |
| --- | --- | --- | --- |
| `VerifiedFile` | one large file, such as PMTiles | byte ranges | DRISL descriptor plus meta/shard proof tree |
| `VerifiedAsset` | one file or path-addressed bundle | whole files | raw CID or strict MASL bundle in a CARv1 bag |

Hosts need only GET. Publishing is `cp`; mirroring is `rsync`.

## 1. CIDs and anchors

All accepted CIDs are DASL CIDs: CIDv1, lowercase base32 text, sha2-256,
32-byte digest, and codec `raw` (0x55) or `dag-cbor` (0x71). CIDv0,
other multibases, other hashes, `dag-pb` anchors, and `car` anchors reject.

| anchor codec | names | accepted by |
| --- | --- | --- |
| `dag-cbor` | a ranges descriptor | `VerifiedFile` |
| `dag-cbor` | a MASL asset manifest | `VerifiedAsset` |
| `raw` | one whole file, at most 256 KiB | `VerifiedAsset` |

The client class is configuration, not content sniffing. A dag-cbor block is
decoded only as the template required by that class: a descriptor supplied to
`VerifiedAsset`, or a manifest supplied to `VerifiedFile`, rejects.

## 2. Ranged files

### 2.1 Descriptor

`{proof}/root` is a DRISL block, fetched whole (at most 256 KiB) and hashed
against the anchor before parsing. DRISL means deterministic CBOR with tag 42
CID links; map keys are in encoded-key order and all integers and lengths use
their shortest representation.

The descriptor accepts exactly one of these templates:

```
{
  "v": 1,
  "map": <tag-42 raw CID>,
  "meta": <bytes>,
  "mapSize": <uint < 2^53>
}
```

```
{
  "v": 1,
  "map": <tag-42 raw CID>,
  "meta": <bytes>,
  "unixfs": <tag-42 raw-or-dag-pb CID>,
  "mapSize": <uint < 2^53>
}
```

`map` is sha2-256 of the complete file. `mapSize` must equal the coverage of

### 2.2 Proof tree

The proof directory has one fixed name and all remaining names are derived:

```
{proof}/root            descriptor
{proof}/{hex}           shard, named by absolute span start
{proof}/{hex}/meta      child meta
{proof}/{hex}/{hex2}    nested shard
```

Names are unpadded lowercase hexadecimal byte offsets. Every proof file below

```
shard := (u32le(relativeOffset) digest32)+
meta  := (kind:u8 u64le(length >= 1) digest32)+
```

A shard is at most 64 KiB (1,820 records). A meta is at most 256 KiB (6,397
records). `kind` 0 names a shard; `kind` 1 names a child directory. Meta child
ranges are consecutive prefix sums. All proof files parse exactly to EOF.

### 2.3 Reading

At open, fetch and authenticate `root`, decode it, and retain its top meta.
For a read, descend only the metas and shards covering the requested range.
Each needed leaf is fetched with a single-range `Range` request, grouped with
adjacent uncached leaves where possible. Every slice is sha-256 checked before
any slice from that response is cached. A client may speculatively fetch an
exact requested range while it descends the proof tree, but may adopt it only

## 3. Assets

### 3.1 Raw assets

A raw anchor represents exactly one file. `bytes("")` GETs the configured URL,
rejects. Raw assets have no proof URL.

### 3.2 MASL bundles

A bundle anchor is a dag-cbor CID of a strict MASL bundle profile. Its proof
is a CARv1 bag containing the manifest block; optional raw blocks in the bag
may contain asset bytes. The client locates the manifest by the anchor digest,

The manifest is a DRISL map no larger than 256 KiB:

```
{
  "$type": "ing.dasl.masl", // optional
  "resources": {
    "/style.json": {
      "src": <tag-42 raw CID>,
      "size": <uint < 2^53>,
      "content-type": "application/json" // optional
    }
  }
}
```

Only `$type` and `resources` are accepted at the top level. When present,
`$type` must be exactly `ing.dasl.masl`. A resource entry accepts only `src`,

Resource paths are full paths, not directories. They start with `/`, are at
most 4,096 UTF-8 bytes, contain at most 32 nonempty segments, and no segment
may be `.`, `..`, NUL-containing, or over 255 UTF-8 bytes. An empty requested
path resolves `/`. A missing authenticated path raises `NotFoundError`.

For a bundle entry, the client first verifies and uses a matching raw CAR
section when one is present. A lying optional raw section is discarded and the
client falls back to the content URL without banning it. Otherwise the client
GETs `{base}/{path}`, bounds it by `size`, and sha-256 checks it against `src`.
The latter mismatch is a content-host fault.

### 3.3 CAR transport

Proofs are CARv1 only. The header is length-skipped and untrusted. Sections
are minimal-varint length-prefixed binary DASL CIDs followed by bytes; section
CIDs are untrusted lookup keys until a selected block is hashed. Duplicate

Raw sections are 0 to 8 MiB. Dag-cbor sections are 1 byte to 256 KiB. A proof
CAR is bounded by `maxProofBytes` before parsing (default 32 MiB).

## 4. Client behavior

`source` and `proof` locations are hints, never identity. Content sources are
tried in order; proof sources are tried in order. The default proof location
is `{source}.proofs` for `VerifiedFile` and `{source}.car` for bundle assets.
An explicit proof URL is required when a source URL has a query string.

- Proof faults (bad framing, failed parent digest, malformed structure,
  oversized proof) increment `rejected`, fail over to the next proof source,
  and retry on a later call after all sources fail.
- Content faults (wrong length or digest) increment `rejected`, ban that
  content source for the client session, and fail over.
- Transport faults (network error, non-2xx, missing derived proof file) do not
  increment `rejected` and do not ban a source.

`stats` exposes `{ verified, rejected }`. Verified buffers are immutable,

## 5. Hosts

| requirement | why |
| --- | --- |
| `GET` for files and proofs | all paths |
| exact single `Range` response (`206`) | `VerifiedFile` content reads only |
| HTTPS or localhost | WebCrypto secure context |
| CORS allowing GET; allow `Range` on OPTIONS when required | cross-origin embedding |
| immutable URLs | verified content is immutable |

Proof hosts never require `Range`. Asset hosts never require `Range`.
`VerifiedFile` content responses must use identity encoding: transparent
compression changes bytes and therefore fails verification.

## 6. Publishing

The reference packer is a repository development tool; it is not part of the
published client library package. Run it from a clone of this repository after
`npm ci`.

```
npm run pack -- world.pmtiles
npm run pack -- world.pmtiles --unixfs --full-car world.car
npm run pack -- assets ./public --out assets.car
```

The default ranges pack writes `world.pmtiles.proofs/` and prints a dag-cbor

`pack assets <dir>` writes a MASL CAR and prints its dag-cbor manifest anchor.
It bundles files no larger than 8 MiB as optional raw CAR sections; larger

## 7. IPFS and DASL interoperability

DASL/atproto compatibility is the primary format rule: anchors, manifest
links, and CAR sections accepted by clients are raw or dag-cbor CIDs only.
The optional descriptor `unixfs` value is deliberately an opaque IPFS bridge,

Small raw assets and manifest blocks are already valid IPFS blocks by their

## 8. Non-goals

Availability, freshness, confidentiality, and privacy of access patterns are
