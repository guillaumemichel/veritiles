# veritiles — Verified Content over Dumb Hosts

One trust model, two proof systems:

- the **anchor** is a single CID — the client's only trust input;
- **verification is lazy**: at open, one small block is checked against
  the anchor; everything else is verified on first use against the
  digest an already-verified parent committed. No byte is used before
  the sha2-256 chain from the anchor reaches it;
- hosts are **dumb**: static files and `GET`. Publishing is `cp`,
  mirroring is `rsync`.

Two client classes, one per workload — each with the proof system that
serves it best:

| class           | content shape                                      | reads                       | proof system                                                  |
| --------------- | -------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `VerifiedFile`  | one large file (a PMTiles archive, video, …)       | byte ranges (`Range` + 206) | a **proof tree**: dag-cbor descriptor + meta/shard files (§3) |
| `VerifiedAsset` | a file or directory tree (styles, glyphs, sprites) | whole files (plain GET)     | a **CAR bag** of UnixFS blocks (§4)                           |

Why two: ranged reads of a huge file need _offset-addressable_ proofs of
~constant size — fetching one whole-DAG proof upfront does not scale
(planet-scale archives would need gigabytes before the first tile).
Whole-file assets need nothing of the sort — one small CAR per artifact
is simpler and standard. Both paths share §§5–6 (client behavior, host
contract).

---

## §1. Design goals

1. **Client-first.** The server stores files and answers `GET`
   (optionally with one `Range` header). It never assembles proofs,
   never computes, never runs tile server or IPFS software.
2. **Fail closed.** Hosts and networks are untrusted; they can withhold
   bytes (visible denial of service) but can never alter a byte
   undetected. Every verification failure is counted and attributed.
3. **Pay only for what you read.** Proof bytes are fetched in small
   pieces covering the requested range, and verification cost is one
   sha2-256 over exactly the bytes used, when they are first used.
4. **IPFS interop is free, not required.** Anchors are plain CIDs and
   the content's UnixFS root CID travels in every descriptor (§3.1), so
   pinning, gateways, and standard tooling all work — but no rule below
   depends on IPFS existing.

## §2. Anchors

The anchor MUST be CIDv1, multibase base32 lowercase, multihash
sha2-256 with a 32-byte digest. Its codec declares the artifact kind —
clients MUST NOT sniff bodies or URLs; anything else rejects:

| anchor codec      | names                                   | accepted by     |
| ----------------- | --------------------------------------- | --------------- |
| `dag-cbor` (0x71) | a proof **descriptor** (§3.1)           | `VerifiedFile`  |
| `raw` (0x55)      | single-block content (a file ≤ 256 KiB) | `VerifiedAsset` |
| `dag-pb` (0x70)   | the root node of a UnixFS DAG (§4.3)    | `VerifiedAsset` |

A `car` (0x0202) anchor codec MUST reject (it was the 0.2.0 assets
anchor and is retired).

The anchor commits to the content _and_ its exact proof structure via
the hash chain. Two packagings of the same bytes with different cut
points are two anchors — inherent to Merkle structures, the same way a
piece-size change alters a BitTorrent infohash. Publishers SHOULD build
with the documented profiles (§8) so independent publishers converge.

Security basis: every digest a client compares against is fixed before
any attacker acts — the anchor digest by configuration, every other by
an already-verified parent. Substituting bytes anywhere in the chain
requires a **second preimage** of sha2-256, a strictly harder problem
than a collision.

Clients MUST take anchors only from configuration or from
already-verified content (e.g. a verified style), never from URLs. A
URL path that happens to contain a CID is an unenforced claim.

## §3. The ranges proof (VerifiedFile)

The proof is a directory of small static files: one **descriptor** (the
anchor's block) plus a tree of **meta** and **shard** files. Every file
below the descriptor is located by _derivation_ — the client computes
each filename from verified spans; there is no index, no manifest, no
directory listing anywhere.

### §3.1 The descriptor — `{proof}/root`

A single dag-cbor block, canonical encoding, fetched whole (≤ 256 KiB)
and hashed against the anchor before any parsing — the one hash at
open. Fixed template (keys in canonical length-first order; shortest
integer and length forms; only the marked values vary):

```
a4                       map(4)
  61 76                  "v"       → uint, the format version: 1
  63 6d 61 70            "map"     → tag(42) bytes(37): 0x00 + binary CIDv1
  64 6d 65 74 61         "meta"    → byte string: the TOP META file (§3.2)
  67 6d 61 70 53 69 7a 65 "mapSize" → uint < 2⁵³, the map file's size
```

- **`map`** — the map file's UnixFS root CID (codec `raw` or `dag-pb`,
  sha2-256/32): the content binding. The leaf digests in the proof tree
  ARE that DAG's raw-leaf digests (same cuts, same bytes), so the
  binding is cross-checkable with standard tooling — but the client
  never needs the DAG. Consequence: any byte-source of the same file
  (a static mirror, an IPFS gateway) is a valid content source.
- **`meta`** — the embedded top meta. Embedding it means the derivation
  chain (§3.3) always starts in memory: open costs exactly one fetch.
- **`mapSize`** — MUST equal the embedded meta's coverage (§3.2); a
  mismatch rejects the descriptor.

Strict decode: exactly these keys, exactly this order and these types;
unknown keys, wrong types, non-canonical forms, or trailing bytes
reject. A `v` other than 1 rejects.

### §3.2 Meta and shard files

Binary formats; every integer is fixed-width little-endian; digests are
raw 32-byte sha2-256 outputs. Every file is a plain sequence of records
and must parse to exactly EOF.

```
shard := ( u32le(relOffset)        digest32 )+    36 B records
meta  := ( kind:u8 u64le(length≥1) digest32 )+    41 B records
         kind 0 → shard file named hex(spanStart)
         kind 1 → subdirectory; its entries live in {name}/meta
```

**Shard** — the leaf-digest list for one contiguous byte range:

- offsets are relative to the shard's absolute start (its filename);
  the first record is at 0 and records ascend strictly; each record
  covers until the next, the last until the span the parent meta
  committed. Gaps and zero-length leaves are unrepresentable.
- hard-capped at 64 KiB (1,820 records); with leaves ≤ 1 MiB the span
  fits u32 with headroom.
- records are fixed-size, so a digest-verified shard is binary-searched
  in place — the buffer IS the index; no parsing, no derived
  structures. Structural validation (framing, first-at-0, strict
  ascent, last-within-span) runs once per fetched shard.

**Meta** — the interior node: contiguous child ranges as prefix sums of
`length` from the directory's own range start; lengths < 2⁵³. A meta
covers exactly the span its parent (or, for the top meta, the
descriptor's `mapSize`) committed — checked on every decode. Capped at
256 KiB (6,397 entries).

### §3.3 Names, layout, and derivation

```
{proof}/root            the descriptor (§3.1) — the only fixed name
{proof}/{hex}           a shard file, named by its absolute span start
{proof}/{hex}/meta      a subdirectory's meta (kind-1 children)
{proof}/{hex}/{hex2}    …and its shards, one directory level per level
```

- Names are **unpadded lowercase hex** of the absolute span start
  (`start.toString(16)`). They are computed by the client, never
  parsed.
- A read descends: binary-search the current meta's records (in
  memory) → the covering entry's absolute span start (prefix sums) →
  the child's exact filename → fetch it (unless cached) → repeat until
  a kind-0 entry yields the leaf digests. Each fetched file is hashed
  against the digest its parent committed before use.
- There is **no discovery**: availability is committed by the anchor. A
  derived name that 404s is an incomplete proof tree — a proof fault
  (§5.2), never a search miss.
- Everything below the descriptor is fetched by plain GET — proof hosts
  need no `Range` support. All proof files are immutable: cache by
  digest, without expiry.

### §3.4 Reading a byte range

```
open(anchor):                        lazy, memoized; a failure clears
                                     the memo so the next read retries
  bytes ← GET {proof}/root           ≤ 256 KiB
  require sha256(bytes) == anchor.digest
  decode per §3.1 (strict); size = mapSize; top meta in hand

read(offset, length):
  clamp [offset, end) to size; empty → empty bytes
  leaves ← descend metas/shards per §3.3 for the covering paths only
  for each needed leaf L, in this order:
    1. verified cache hit → copy
    2. fetch: group remaining leaves into maximal file-contiguous
       runs; one `Range` GET per run on a content source; the body
       length must equal the run; sha256(slice_i) must equal
       L_i.digest for every leaf — all verified before any cached,
       one bad slice rejects the whole run to the next source
  assemble; return exactly [offset, end), a fresh copy
```

While a cold region's descent is still fetching, a client SHOULD issue
the exact requested range as a **speculative unverified fetch** in
parallel, then adopt it slice-by-slice once leaf digests are known
(all-before-any caching), discarding it on any mismatch — tampering
costs one retry and one `rejected`, never integrity, and never a cache
entry. Tile reads over a §8.2-cut archive are leaf-aligned, so a
region's first tile costs one round trip, not two.

## §4. The assets proof (VerifiedAsset)

A proof is a [CARv1](https://ipld.io/specs/transport/car/carv1/) (or
wrapped [CARv2](https://ipld.io/specs/transport/car/carv2/)) archive of
the artifact DAG's internal blocks, treated as an **untrusted bag of
blocks**: framing is parsed strictly, but block bytes are **not hashed
at parse time** — each is verified on first use against the digest an
already-verified parent committed.

### §4.1 Framing

- **CARv2 detection** is the exact 11-byte pragma
  (`0a a1 67 76 65 72 73 69 6f 6e 02`); anything else parses as CARv1.
  The payload window MUST lie inside the body; bytes outside it
  (padding, the index region) are ignored. Never assume the payload
  starts at byte 51 — padding is legal.
- **The CARv1 header is length-skipped, not parsed.** Its `roots` carry
  no trust: the root is located by digest lookup among the sections,
  so multi-root CARs and `ipfs dag export` output are acceptable
  proofs, and one CAR MAY serve several anchors.
- **Section rules** (violations reject the whole proof as an authored
  fault): varints minimal; section length within `[36, 36 + 2²³]`; the
  CID a binary CIDv1, sha2-256/32, codec `raw` or `dag-pb`; `dag-pb`
  block length 1..2²⁰ bytes; `raw` block length 0..2²³ bytes (0 permits
  the empty file's leaf); a section running past the end, or trailing
  bytes that are not a whole section, reject.
- **Duplicate digests reject.**
- The claimed section CID is an **index key, nothing more**. Its digest
  keys the bag; its bytes are hashed against the link that references
  it at use. A section lying about its bytes is accepted at parse and
  caught at use.

### §4.2 Completeness and transport

The union of a client's proof sources MUST contain every `dag-pb` block
reachable from the anchor; a resolution that needs a missing block is a
proof fault (§5.2). `raw` sections are OPTIONAL content: one whose
digest matches a _needed_ leaf MAY be verified and used as content.
All other sections MUST be ignored and MUST NOT be cached.

Completeness is distinct from integrity and checkable at open: walk
from the verified root and require every reachable `dag-pb` link digest
to have a section in the bag (decode-only; hashing stays lazy).
Clients SHOULD run this walk at open for untrusted sources.

v1 clients fetch a proof URL whole with a plain GET, bounded by
`maxProofBytes` **before** parsing (§7). A verified proof is immutable:
cache by anchor without expiry.

### §4.3 DAG rules

By anchor codec:

- **`raw`** — the content is a single leaf; no proof exists or is ever
  fetched: the whole body is fetched from the content URL (≤ 256 KiB)
  and hashed against the anchor.
- **`dag-pb`** — the root block MUST decode as a strict UnixFS node.
  Two node types are accepted; everything else — `Raw`, `Symlink`,
  `Metadata`, `HAMTShard` types, CIDv0 links, non-sha2-256 — rejects.

**Directory** (`Type` = 1):

- every link: `Name` present, valid UTF-8, 1–255 bytes, no `/`, no NUL,
  not `.` or `..`; `Hash` a CIDv1, sha2-256/32, codec `raw` or
  `dag-pb`; `Tsize` ignored;
- links sorted strictly ascending by the UTF-8 bytes of `Name` —
  duplicates unrepresentable, binary search valid;
- UnixFS `Data` (2), `filesize` (3), `blocksizes` (4), `hashType` (5),
  `fanout` (6) MUST be absent.

**File** (`Type` = 2):

- ≥ 1 links, each with empty/absent `Name`; `blocksizes` count equals
  the link count; every blocksize ≥ 1; `filesize` present and equal to
  the sum of `blocksizes`; all integers < 2⁵³;
- UnixFS `Data` (2), `hashType` (5), `fanout` (6) MUST be absent
  (leaves are `raw` blocks, never inline);
- each link resolves, in order, to the next `blocksizes[i]` bytes of
  the file: a `raw` CID is a leaf covering exactly that slice; a
  `dag-pb` CID is a nested File node whose own `filesize` MUST equal
  `blocksizes[i]`. File-DAG depth is capped at 16.

In both node types `mode` (7) / `mtime` (8) are ignored if present.

Wire reference for zero-dependency decoders (protobuf field · tag
byte): PBNode: `Links` 2·0x12 (repeated, precede Data), `Data` 1·0x0a.
PBLink: `Hash` 1·0x0a, `Name` 2·0x12, `Tsize` 3·0x18 (this order).
UnixFS `Data`: `Type` 1·0x08, `Data` 2·0x12, `filesize` 3·0x18,
`blocksizes` 4·0x20 (repeated varint, unpacked), `hashType` 5·0x28,
`fanout` 6·0x30, `mode` 7·0x38, `mtime` 8·0x42.

### §4.4 Resolving a path

```
resolve(p):
  segments ← split p on "/"; each nonempty, ≤ 255 UTF-8 bytes,
             not "." or "..", count ≤ 32; violations reject
             before any fetch
  raw anchor: any segment rejects; bytes = GET {base}, ≤ 256 KiB,
              sha256 must equal anchor digest
  dag-pb anchor: cid ← anchor
    for each segment s:
      n ← node(cid.digest)          verified on use (below)
      require n is a Directory      else reject
      link ← binary-search n.links for s
      absent → NotFound              authenticated absence: the
                                     artifact provably lacks the path
      cid ← link.Hash
    return fileBytes(cid, url(base, segments))

fileBytes(cid, url):
  raw cid    → GET url, ≤ 256 KiB; sha256 must equal cid.digest
  dag-pb cid → n ← node(cid.digest); require File;
               require n.filesize ≤ maxFileBytes (before any request);
               flatten to leaves via node() (depth ≤ 16, nested
               filesize = blocksize); GET url — the body must be
               exactly filesize bytes; verify consecutive slices
               against leaf digests; all before any caching
```

where the one primitive is verified node access:

```
node(D, label):                     D = a digest committed by an
                                    already-verified parent (or the anchor)
  if verified-memo has D → return it              (no re-hash, ever)
  bytes ← current bag[D]            missing → proof fault (§5.2)
  require sha256(bytes) == D        mismatch → proof fault (§5.2)
  decode per §4.3, enforce every rule; memoize; return
```

An empty path on a File (or raw) artifact yields the file; on a
Directory artifact it rejects. A path descending through a file
rejects. `NotFound` is not an error of any host — an HTTP 404, by
contrast, proves nothing.

## §5. Client behavior

### §5.1 Configuration

Per anchor: `{ cid, source, proof? }` — the anchor; one or more
**content URLs** tried in order (`VerifiedFile`: URLs of the file
itself; `VerifiedAsset`: base URLs of the mirrored tree); one or more
**proof locations** tried in order — for `VerifiedFile` the base URLs
of the proof directory (default `{source}.proofs`), for `VerifiedAsset`
proof CAR URLs (default `{source}.car`). The default is invalid when a
source URL carries a query string — an explicit `proof` is then
required. `proof` with a raw-anchored `VerifiedAsset` is a
configuration error (no proof ever exists for it). Locations are
hints, never identity.

The `VerifiedAsset` option `checkProofCompleteness?: boolean` (default
`true`) enables the decode-only reachable-structure walk at open
(§4.2); `false` restores lazy hole discovery. `VerifiedFile` discovers
holes lazily by construction (§3.3) and MAY run an analogous whole-tree
walk at open; it is never required.

### §5.2 Failure taxonomy and attribution

- **Proof faults** — framing errors, a descriptor failing the anchor
  hash, a malformed descriptor or meta, a proof file failing the digest
  its parent committed, an oversized proof body: count one `rejected`,
  advance to the next proof location, and retry the lookup. All
  locations exhausted → the read fails (`VerificationError`); a later
  read retries from the first (hosts recover). Verified buffers are
  anchor-derived facts: they survive failover.
- **Content faults** — a response body failing verification (wrong
  length, slice digest mismatch): count one `rejected` per response,
  **ban that content source for the session** (it served tampered
  bytes), fail over to the next. Tamperers don't recover; the ban is
  in-memory only.
- **Transport faults** — network errors, non-2xx (including a 404 on a
  derived proof file), a 200 where 206 was required: not counted,
  never banned; fail over for this read, retry the source on later
  reads.
- A ranged GET answered 200 means the host ignores `Range` and would
  ship the whole archive per tile: surface it distinctly
  (`RangeUnsupportedError`); likewise a CORS-blocked `Range`
  (`RangeBlockedError`).

### §5.3 Counting

`{ verified, rejected }` per client instance. One `verified` per
sha2-256 check passed — the descriptor at open, each proof file on
first verification, each content leaf slice or whole body. One
`rejected` per check failed or proof location rejected. Stats are the
observable record that tampering was caught.

### §5.4 Caching and bounds

All verified data is immutable: cache by digest, LRU under a byte
budget (content default 64 MiB; proofs are small and get their own
smaller budget). In-flight identical fetches are deduplicated;
aborting one consumer releases a shared fetch only when its last
consumer leaves. Every unverified read is bounded before use: the
descriptor by its cap, proof files by their format caps, whole files by
their verified size, ranged bodies by the requested length.

### §5.5 Untrusted discovery (assets)

Proof and content sources may be discovered from open provider networks
(content routers, DHTs): provider records keyed by the anchor CID,
tagged by the service offered. The routing key is the anchor, never a
hash of the proof: CAR proofs are untrusted bags from any source (§4),
so anyone can mirror one, or regenerate one from the content, without
coordination. §4.2's open-time completeness check and §5.2's
attribution are the defenses, and SHOULD be applied in such
environments.

## §6. Host contract

| Requirement                                                    | Why                                                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` for published files and proofs                           | everything                                                                                                                                                              |
| Single `Range: bytes=a-b` → `206`, exactly those stored bytes  | `VerifiedFile` **content** reads only; identity encoding — transparent compression of ranged responses corrupts slices (detected, fails closed)                         |
| HTTPS or localhost                                             | WebCrypto requires a secure context                                                                                                                                     |
| CORS `Access-Control-Allow-Origin: *` (cross-origin embedding) | plain GETs are simple requests; single-range `Range` is safelisted in Chromium; Firefox preflights, so cross-origin ranged hosts must answer `OPTIONS` allowing `Range` |
| Immutable content per URL                                      | content-addressed; `Cache-Control: immutable` is safe                                                                                                                   |

Nothing else: no `Content-Length` trusted or required, no multi-range,
no HEAD, no custom headers, no server-side logic. **Proof hosts never
need `Range`** (proof files are fetched whole), and `VerifiedAsset`
hosts never need it at all.

## §7. Limits

| constant                                          | value                              | where          |
| ------------------------------------------------- | ---------------------------------- | -------------- |
| descriptor body (`{proof}/root`)                  | ≤ 256 KiB                          | format (§3.1)  |
| meta file                                         | ≤ 256 KiB (6,397 records)          | format (§3.2)  |
| shard file                                        | ≤ 64 KiB (1,820 records)           | format (§3.2)  |
| leaf span (ranges path)                           | 1 B – 1 MiB                        | format (§3.2)  |
| proof-tree depth                                  | ≤ 8                                | client (§3.3)  |
| proof body, whole fetch (`VerifiedAsset`)         | ≤ `maxProofBytes` (default 32 MiB) | client, config |
| `dag-pb` block                                    | 1 B – 1 MiB (2²⁰)                  | format (§4.1)  |
| `raw` section                                     | 0 B – 8 MiB (2²³)                  | format (§4.1)  |
| raw artifact / whole leaf fetch (`VerifiedAsset`) | ≤ 256 KiB                          | client         |
| `maxFileBytes` (`VerifiedAsset` DAG files)        | default 64 MiB                     | client, config |
| file-DAG depth                                    | ≤ 16                               | client (§4.3)  |
| link name                                         | ≤ 255 B                            | format (§4.3)  |
| path segments                                     | ≤ 32                               | client (§4.4)  |
| integers (sizes, offsets)                         | < 2⁵³                              | format         |
| hash                                              | sha2-256 only                      | format         |

## §8. Publisher profiles (generator side)

Import invariants for the map CID: CIDv1, sha2-256, base32 text; `raw`
leaves; balanced layout unless stated; plain `dag-pb` nodes — **no HAMT
sharding** (builders MUST fail instead); `mode`/`mtime` omitted. This
is `ipfs add --cid-version 1` with default settings, or the equivalent
importer call. The chunker is the profile's one degree of freedom: cut
points are a _partition_ of the file — profiles choose boundaries,
never reorder or transform bytes.

The proof tree is built bottom-up from the same cuts: leaf digests
(sha2-256 of each chunk) packed ≤ 1,820 per shard; metas ≤ 6,397
entries, nested left-shallow beyond that; the top meta embedded in the
descriptor. Builders MUST fail when the descriptor would exceed its
256 KiB cap — nest the tree deeper instead.

### §8.1 Profile `fixed` (any content)

Size-N chunks (default 1 MiB), one band — the whole tree hangs
uniformly off the top meta. MUST reproduce
`ipfs add --cid-version 1 --chunker size-N` exactly for the map CID.
Verification granularity = chunk size = worst-case over-fetch for a
sub-chunk read. Content types with natural boundaries (DASH/HLS
segments, archive members) SHOULD cut at those boundaries instead —
same client, no code change.

### §8.2 Profile `pmtiles` (an optimization only)

Clients cannot tell profiles apart and MUST NOT need to. Cut at: byte
16384 (the fixed first read every pmtiles client makes), each section
boundary (root directory, metadata, leaf directories, tile data), each
leaf directory, and each tile — optionally grouping consecutive tiles
up to a size budget. Result: every read a pmtiles renderer performs is
leaf-aligned — zero over-fetch, one exact `Range` request. Identical
tiles (deduplicated ranges in clustered archives) become identical
leaf digests: stored once, cache-hit on read.

**Zoom shaping.** Tile data is z-major (tile IDs are Hilbert indices),
so the builder cuts the proof tree along zoom boundaries: the head
regions (header, root directory, metadata, leaf directories) form the
first band, then one band per zoom level — a small band lists its
shards directly in the top meta, a large one becomes a subdirectory
with its own meta tree. Consequences: low zooms sit at depth ≤ 1,
max zoom goes as deep as its tile count needs, panning at one zoom
only touches that band's subtree, and the top meta (hence the
descriptor) stays small at any scale — planet included.

## §9. Integration (non-normative)

```js
const source = new VerifiedSource({ cid: MAP_ANCHOR, source: mapUrl });
protocol.add(new pmtiles.PMTiles(source)); // MapLibre
// leafletLayer({ url: new pmtiles.PMTiles(source) }) // Leaflet
// new PMTilesVectorSource({ url: source })           // OpenLayers

const fonts = new VerifiedAsset({ cid: FONTS_CID, source: fontsBase });
maplibregl.addProtocol("verified", assetProtocol([fonts]));

const style = new VerifiedAsset({ cid: STYLE_CID, source: styleUrl });
const map = new maplibregl.Map({
  container: "map",
  style: JSON.parse(new TextDecoder().decode(await style.bytes(""))),
});
```

with, inside the verified `style.json`:

```json
{
  "sources": { "v": { "type": "vector", "url": "pmtiles://<map anchor>" } },
  "glyphs": "verified://<fonts CID>/{fontstack}/{range}.pbf"
}
```

`pmtiles://` and `verified://` URLs carry the **anchor, never the
location**; URLs come from page configuration. Adapter policy: a
`NotFound` glyph range resolves to an empty response (MapLibre
tolerates sparse ranges); `NotFound` on styles or sprites, and every
`VerificationError`, surface as errors.

## §10. Security considerations

- **Unverified inputs are exactly** HTTP bodies, each bounded before
  use and then hash-verified or discarded (the largest is a whole
  assets proof, capped by `maxProofBytes`). CAR _framing_ and descriptor
  _framing_ are parsed before verification — strict, bounded,
  allocation-light parsers are the accepted surface; block _contents_
  are never interpreted before hashing.
- **Sizes come only from verified data** — a descriptor's `mapSize`, a
  root node's `filesize`, a verified block's length — never from
  `Content-Length`, `Content-Range`, or HTTP status.
- **No sniffing.** The anchor codec decides everything.
- **A hostile proof host** can cost at most bounded fetches plus one
  hash per file it lies about, and can never place bytes in the
  verified cache (verify-before-cache everywhere). An incomplete proof
  tree — files omitted to waste fetchers' bandwidth — is caught at
  latest by a proof fault on first use of the hole (a derived name
  404s; the read fails over), never integrity and never content bytes.
  It cannot influence _what_ verifies — only whether verification
  succeeds.
- **A hostile content host** is caught per response, banned for the
  session, and survived via failover.
- **Path safety.** Ranges-path filenames are derived hex offsets — no
  host input reaches a URL. Assets link names and requested segments
  are validated (§4.3, §4.4) so no name can steer a URL outside
  `{base}`.
- **Non-goals.** Availability (a host can refuse), freshness (anchors
  are immutable; pair with IPNS/DNSLink externally), privacy of access
  patterns, confidentiality (content is public data).

## §11. Future work

- **UnixFS directories for `VerifiedFile`** — anchor a directory,
  `read(path, offset, length)`; the ranges proof tree would gain a name
  level. This also merges `VerifiedAsset` into `VerifiedFile` + a
  whole-read convenience.
- **HAMT-sharded directories** — forbidden today; builders fail.
- **Streaming verification** — verify leaf-by-leaf as ranged bodies
  stream; format already permits, client-only.
- **Trustless gateways as sources** — proof files and content by CID,
  gateway content sources (the descriptor's `map` binding already
  makes the content side trivial).
- **Shareable locators** — one magnet-style string bundling anchor +
  proof URLs + content URLs.
- **A BLAKE3+bao twin** — same transport/store/read loop, anchor =
  `blake3(file)`, proof = a bao outboard; benchmarked head-to-head
  before graduating. (Rejected: no WebCrypto BLAKE3, positional
  chunking forbids content-aware cuts, no settled JS verifier.)

## §12. Prior art (non-normative)

This design intentionally mirrors BitTorrent web seeding
([BEP 19](https://www.bittorrent.org/beps/bep_0019.html)): a compact
trust root distributed independently of the data; dumb file hosts;
piece hashes verified client-side. The mapping: infohash → anchor CID;
`.torrent` metainfo → the descriptor + meta/shard tree; `xs=` → proof
locations; `ws=` web seeds → content URLs. Lessons inherited: dumb
hosts won (BEP 17 died, BEP 19 survived); locations are hints, never
identity; ban on tamper, retry on busy; per-file trees beat flat
pieces. Where BitTorrent never resolved merkle proofs vs dumb HTTP
hosts (BEP 30 died), hosting the proof as static files — small,
digest-committed, fetchable from anywhere — is the resolution.

Adjacent: BLAKE3/bao _outboard_ encoding and iroh's verified ranges
are the same sidecar idea with a positional tree (see §11); the IPFS
trustless gateway verifies but requires protocol-aware hosts; SRI
verifies whole subresources only after full buffering.
