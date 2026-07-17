# veritiles — Formats & Client Protocol

Two wire formats, one trust philosophy: a single CID is the only trust
input, hosts are dumb static file servers, and every byte is hash-verified
before use.

- **Part 1 — Map packages** (`formatVersion: 1`, read by `VerifiedSource`):
  a range-readable PMTiles archive plus integrity proofs for arbitrary byte
  ranges of it. Implemented.
- **Part 2 — Verified assets** (CARv1 strict profile, read by
  `VerifiedAsset`): whole-file resources — a style, a sprite set, font
  glyphs, any directory tree. Implemented in veritiles 0.2.0.

Sections are prefixed by part: `Mn` points into Part 1 (Map packages),
`An` into Part 2 (Assets). Source comments and the test suite cite
assets rules the same way (`An`).

---

## Part 1 — Map packages: range-verified PMTiles (formatVersion 1)

A _package_ is a directory of plain files published on any static host and
identified by a single IPFS root CID. A client that knows only that CID can
fetch the package's content and verify every byte it renders, with no trust
in the host. This part defines the **map package** — a range-readable map
archive plus the integrity proofs for arbitrary byte ranges of it — read in
the browser by `VerifiedSource`. Everything else a map needs — the style,
sprites, glyphs — is a whole-file resource and ships as a **verified
asset** (Part 2), not as a package.

### M1. Design goal: optimize for the client, not the server

The server is deliberately as dumb as possible: it stores files and answers
`GET`, optionally with one `Range` header. It never assembles proofs, never
computes, never runs IPFS software; publishing is `cp`, mirroring is
`rsync`. Every design decision below spends _server-side generality_ (a few
percent more proof bytes, one discarded request per session) to buy down
the client budgets:

- **Client CPU.** Verification costs one SHA-256 over exactly the bytes
  fetched, plus an O(log n) binary search — and nothing else. Map proof
  files are fixed-size records, so the fetched buffer **is** the lookup
  structure: no parsing step, no decoded copies, no per-record allocation.
  Hex/string work happens only for the 1–2 records a read actually uses.
- **Latency.** A warm tile read is one exact-range request. A tile in a
  not-yet-proven region is _still one round trip_: the data range is
  fetched speculatively in parallel with the proof descent (M8.3). The
  absolute cold start (nothing cached, first paint) is bounded by the
  manifest + one meta + one shard + one range.
- **Bandwidth.** Tile requests carry zero overhead — exactly the tile's
  stored bytes, same shape as an unverified client. The entire proof
  apparatus is 36 B per leaf, split into ≤ 64 KiB files fetched only for
  regions actually browsed, each immutable and cacheable forever.
- **Client memory.** One copy of everything: verified buffers live in a
  single digest-keyed LRU and are queried in place. There is no derived
  index to build, size, or evict for map data.

### M2. Package layout

```
map package /ipfs/<rootCID>/
├─ map.pmtiles        the archive; a valid PMTiles file, byte-identical on the host
├─ metadata.json      bootstrap manifest (M6) — the only unverified fetch
└─ proofs/
   ├─ meta            index records for this directory (M5.2)
   ├─ {hex16}         shard files (M5.1), named by absolute start offset
   └─ {hex16}/        subdirectories (same rule, recursive) at larger scales
```

`{hex16}` is the 16-digit zero-padded lowercase hex of the **absolute byte
offset** where the file's (or directory's) coverage begins. Names are never
parsed for trust — they are derived by the client from verified prefix sums
and used only to build URLs. `{base}/{path}` must serve the same bytes as
`/ipfs/<rootCID>/{path}`; a range-capable IPFS gateway path is therefore a
conforming base URL. Publishers MAY name a static base by the same
convention — `…/ipfs/<rootCID>/` — for legibility and IPFS-tool interop;
the name carries no trust. Clients take root CIDs only
from configuration and MUST NOT parse them out of URLs: a path is an
unenforced claim, and a source URL may be attacker-supplied (M3 still holds
because a wrong source merely fails verification).

### M3. Trust model

The package's root CID is the only trust input. `metadata.json` is
authenticated by reconstructing the root directory node from it (M7); every
other value is then authenticated strictly downward:

```
manifest → meta digest → shard digest → leaf digest → tile bytes
```

The host and network are untrusted: they can withhold bytes (denial of
service, visible) but cannot alter any byte undetected (verification fails
closed; the client retries the next source or surfaces an error). All
digests are raw 32-byte SHA-256; the algorithm is declared once in the
manifest.

### M4. Single-leaf rule

Every published file except the map archive MUST be imported as a single
raw UnixFS leaf of ≤ 256 KiB (262,144 B, the default chunker's split
point). A single-raw-leaf file's CID multihash **is** the SHA-256 of its
served bytes, so a digest committed one level up (a `children[].cid`, a
meta entry) doubles as the content hash of a whole-file fetch. Clients cap
these digest-pinned whole-file reads at 256 KiB accordingly;
`metadata.json`, authenticated by root reconstruction instead (M7), carries
its own 1 MiB cap (M10).

### M5. Binary proof formats

Every proof file is a bare sequence of records with no header, no padding,
and no trailer; a file that does not parse to exactly EOF is rejected.
Every integer is fixed-width little-endian — there is no varint anywhere in
the format.

#### M5.1 Shard files — `proofs/…/{hex16}`

```
shard := ( u32le(relativeOffset) digest32 )+        exactly 36 B per record
```

A shard proves one contiguous byte range (its _span_) of the map file. Its
absolute start is its filename; each record's offset is **relative to that
start**. A record covers the bytes from its offset up to the next record's
offset; the last record covers up to the span committed by the parent meta
entry. Validity rules (all MUST, checked once per fetched file):

1. file size is a non-zero multiple of 36 and at most **64 KiB**
   (⇒ ≤ 1,820 records);
2. the first offset is 0 (a shard starts proving at its own name);
3. offsets ascend strictly (⇒ every leaf is ≥ 1 byte);
4. the last offset is less than the parent-committed span.

These rules make gaps, overlaps, and zero-length leaves _unrepresentable_:
verified shards always partition their span exactly.

Rationale (client-first): fixed-width records let the client binary-search
the verified buffer directly — no decode pass, no in-memory index, no
second copy. Offsets are relative so 4 bytes suffice at any archive scale:
a shard's span is bounded by records × max leaf size (1,820 × 1 MiB
≈ 1.8 GB < 2³²), independent of file size. A variable-width encoding would
save a few percent of proof bytes at the cost of that in-place bisect — not
worth it: the entire client-side proof machinery is a fixed-stride index
lookup.

#### M5.2 Meta files — `proofs/…/meta`

```
meta := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+        exactly 41 B per record
```

`kind` 0 = shard file, 1 = subdirectory; anything else rejects. Entries are
range-contiguous in file order: entry _i_ starts where entry _i−1_ ended
(the directory's own start for the first — the top directory starts at 0),
so absolute positions are prefix sums and the child's filename is derived,
not stored. The entry lengths MUST sum exactly to the directory's committed
range. A directory holds at most 256 entries by build policy (an honest
meta is then ≤ 10,496 B); publishers with more shards nest subdirectories
(each with their own `meta`) — the descent rule is byte arithmetic only, so
tree shape is publisher policy, invisible to clients, which bound a meta
only by the whole-file read cap (M4), not the entry count. Lengths are u64
because an entry's range is bounded only by that publisher-chosen shape
(u32 would silently cap an entry at 4 GiB); clients MUST reject values
≥ 2⁵³, past JS integer precision and far beyond any archive.

### M6. `metadata.json` (formatVersion 1)

```json
{
  "formatVersion": 1,
  "hash": "sha2-256",
  "children": [{ "name": "…", "cid": "…", "tsize": 0 }],
  "map": { "file": "map.pmtiles", "size": 123456789 },
  "proofs": { "dir": "proofs", "metaDigest": "<hex64>", "shardCapBytes": 65536 }
}
```

Clients MUST reject any other `formatVersion`. `children` lists `{name,
cid, tsize}` for every root entry **except `metadata.json` itself** (a file
cannot contain its own hash). Every referenced name (a `children[].name`,
`map.file`, `proofs.dir`) MUST be a single non-empty path segment of ≤ 255
UTF-16 code units — no `/`, and not `.` or `..` — so a tampered manifest
can never steer a fetch outside the package base; names must be unique.
Provenance fields (`source`, `attribution`, `chunking`, …) are
informational and ignored by verification.

`metaDigest` is explicit because `proofs` is a directory: its child CID
commits to a dag-pb node the dumb host cannot serve, so the manifest pins
the top `meta` file's content digest directly. `shardCapBytes` is build
documentation — the client enforces the format's own 64 KiB cap instead.

### M7. Bootstrap: reconstructing the root

1. GET `{base}/metadata.json` (the single unverified fetch); hash the
   bytes.
2. Build the dag-pb directory node from `children` plus the self link
   `{Name: "metadata.json", Hash: cidv1-raw(hash), Tsize: byteLength}`,
   links sorted by name (dag-pb's canonical UTF-8 byte order; a manifest
   whose names cannot be encoded in that order is rejected).
3. The node's CIDv1 (dag-pb, SHA-256) MUST equal the configured root CID;
   otherwise reject. Every manifest field is now authenticated.

A map client then requires the `map` and `proofs` sections.

### M8. Client read protocol

#### M8.1 Verification chain (amortized, never re-walked)

Each fetched artifact is hashed once against the digest committed one level
up, then cached by digest; "walking back to the root" happens implicitly
and at most once per artifact per session:

| Artifact      | Checked against                              | Frequency          |
| ------------- | -------------------------------------------- | ------------------ |
| metadata.json | root CID (reconstruction)                    | once per session   |
| proofs/…/meta | parent meta / manifest digest + coverage sum | once per directory |
| shard file    | meta entry digest + M5.1 structure           | once per region    |
| tile bytes    | shard record digest                          | once per leaf      |

#### M8.2 Warm reads

If every meta and shard covering `[a, b)` is already cached, the covering
leaves are resolved synchronously (bisect per shard), cached leaves are
copied, and the remainder is fetched as maximal file-contiguous runs — one
`Range` request per run, rounded out to leaf boundaries so every leaf can
be hashed whole. A single-tile read is one exact-range request; leaf slices
are verified against their record digests before use, all-before-any
caching per run.

#### M8.3 Cold reads — speculative parallel fetch

When the proof descent would touch the network, the client MUST NOT
serialize data behind proofs. It instead:

1. immediately issues an **unverified** `Range: bytes=a..b-1` for exactly
   the requested range (the _speculation_), deduplicated against concurrent
   identical requests and body-capped at the requested length;
2. runs the proof descent in parallel;
3. when the covering leaves arrive, any run of uncached leaves lying
   **entirely inside `[a, b)`** is _adopted_: sliced out of the speculative
   body and digest-verified per leaf, all slices before any caching;
4. runs extending outside `[a, b)` (a read not aligned to leaf boundaries)
   are fetched normally per M8.2, and a speculation no run can use is
   aborted;
5. a speculative body that fails any digest is discarded and the run is
   re-fetched through the verified path — tampering costs one retry and a
   `rejected` statistic, never integrity, and never a cache entry.

Because the archive is chunked tile-aligned, tile reads are leaf-aligned by
construction: the speculation adopts, and a region's first tile costs **one
round trip** (proof fetches ride in parallel) instead of two. The known
misaligned case is the format's header probe (e.g. pmtiles' 16 KiB read),
which discards one small speculative body once per session.

#### M8.4 Caching

One digest-keyed LRU per package holds every verified artifact — tile
leaves, shards, metas. Proof buffers are queried in place (no parsed
forms), so eviction is uniform and re-validation after re-fetch is one
structural scan marked on the buffer. In-flight requests are deduplicated;
aborts release a shared fetch only when its last consumer leaves.

### M9. Host contract

| Requirement                                                         | Why                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET {base}/{path}` for published files                             | manifest, proofs                                                                                                                            |
| Single `Range: bytes=a-b` → `206` with exactly those stored bytes   | tile reads; identity encoding — transparent compression of ranged responses corrupts slices (detected, fails closed)                        |
| HTTPS or localhost                                                  | WebCrypto requires a secure context                                                                                                         |
| Immutable content per URL                                           | convention: root CID in the path; then `Cache-Control: immutable` is safe                                                                   |
| CORS `Access-Control-Allow-Origin: *` (cross-origin embedding only) | single-range `Range` is CORS-safelisted in Chromium; Firefox still preflights, so cross-origin hosts must answer `OPTIONS` allowing `Range` |

Nothing else: no `Content-Length` required, no multi-range, no HEAD, no
custom headers, no server-side proof logic. The client trusts only hashes.

### M10. Limits

| Limit                      | Value                                        | Enforced by                              |
| -------------------------- | -------------------------------------------- | ---------------------------------------- |
| Shard file size            | ≤ 64 KiB (1,820 records)                     | build + client (M5.1)                    |
| Shard record               | exactly 36 B                                 | format                                   |
| Relative offset            | < 2³² (guaranteed by ≤ 1 MiB leaves × 1,820) | build assert + u32 encoding              |
| Leaf (chunk) size          | ≥ 1 B, ≤ 1 MiB                               | build (chunker splits)                   |
| Meta record                | exactly 41 B; rangeLength ≥ 1, < 2⁵³         | format + client (M5.2)                   |
| Meta entries per directory | ≤ 256                                        | build; client caps meta reads at 256 KiB |
| Non-map published files    | single raw leaf ≤ 256 KiB                    | build assert; client read cap (M4)       |
| metadata.json              | ≤ 1 MiB, ≤ 64 children                       | client                                   |

### M11. Versioning

`formatVersion` is a single integer versioning **this package format** —
the manifest schema, the proof formats, and the verification rules — not
the PMTiles archive, which versions itself inside `map.pmtiles`. A client
MUST reject a manifest whose version it does not implement; this part
defines version 1 (pre-release prototypes were never deployed and claim no
number). Changing any binary
format, the manifest schema, or the verification rules requires a new
version and yields new root CIDs; content updates alone also yield a new
root CID (packages are immutable snapshots — there is no in-place mutation
to version).

---

## Part 2 — Verified assets: whole-file resources

**Proof format: CARv1, strict profile** · Status: implemented in
veritiles 0.2.0.

Companion to Part 1, which covers range-verified archives (PMTiles). This
part covers everything else a map needs: **whole-file resources** — a
style, a sprite set, font glyphs, or any other directory tree — fetched
from dumb HTTP hosts and verified in the browser against a single CID
anchor.

### A1. Design goal: no invented trust format

An **artifact** is a plain file or directory. Its trust input is one
**anchor CID** naming at most 256 KiB of bytes; the anchor's codec says
what those bytes are (A2):

- **raw artifact** — a file ≤ 256 KiB. The anchor is the ordinary IPFS
  CID of the file itself; the content is self-verifying and no proof
  exists.
- **DAG artifact** — a UnixFS file or directory of any size. The anchor
  is the CID of a **proof file**: a standard CARv1 archive of the DAG's
  internal nodes (A5). The artifact's root CID travels inside the proof,
  authenticated by the anchor.

Alongside the anchor the client takes only **locations**: untrusted URLs
for the content and, for DAG artifacts, for the proof. Proof and content
are independently hostable (A3). Nothing here invents a format: the trust
structure is the UnixFS DAG, the container is CARv1, the anchor is a
vanilla CID — this spec only pins strict subsets of each and the rules a
client MUST apply when walking them (A5–A7).

Consequences of this shape:

- `{base}/{path}` serves the same bytes as `/ipfs/{root}/{path}`, so a
  static mirror and an IPFS gateway path are interchangeable content
  sources;
- a host serving only the plain files is a complete content source and
  need not know the proof exists — any existing mirror of the data is a
  **web seed** (A14);
- the proof is itself a small IPFS object: pinnable, and fetchable from
  any gateway by its multihash (A2), so "somewhere that has the proof"
  can be the IPFS network itself;
- pinning the artifact root and the proof file pins everything a client
  needs.

The server stays as dumb as Part 1 demands: it stores files and answers
plain `GET`. Assets are fetched whole, so unlike the map package **no
`Range` support is required** and every request is a CORS simple request
(no preflight anywhere).

### A2. Artifact identifiers

The anchor MUST be CIDv1, multibase base32 lowercase, multihash sha2-256
(digest length 32). Its codec declares the artifact kind — clients MUST
NOT sniff bodies; anything but these two codecs rejects:

| anchor codec   | anchored bytes      | artifact is                | verified by                       |
| -------------- | ------------------- | -------------------------- | --------------------------------- |
| `raw` (0x55)   | the content itself  | a single file ≤ 256 KiB    | sha2-256 of the fetched body (A7) |
| `car` (0x0202) | the proof file (A5) | a UnixFS file or directory | proof hash, then DAG walk (A6–A7) |

- A raw artifact's anchor is exactly what `ipfs add --cid-version 1`
  prints for a file ≤ 256 KiB — the expected shape for a typical
  `style.json`. Larger content cannot be a raw artifact (A13); under the
  import profile (A9) it becomes a DAG artifact automatically.
- A DAG artifact's anchor names its proof file, the `car` codec declaring
  what the bytes are. The artifact's own root CID (`dag-pb`) appears only
  inside the proof — never in configuration.
- Anchor and proof file share a multihash: recoding the anchor with codec
  `raw` yields the CID `ipfs add proof.car` prints. The proof is thereby
  pinnable and fetchable by CID like any small file.

CIDs inside the DAG (the proof root and all links) are constrained by
A5–A6.

### A3. Published layout

Content at base URL `{base}` (trailing slashes stripped) is published as:

```
{base}          the file itself (file artifact), or the directory tree
                mirrored as plain files: {base}/{path} for every file,
                byte-identical to /ipfs/{root}/{path}
{base}.car      conventional location of the proof (DAG artifacts)
```

The proof is location-independent. Clients take an explicit ordered list
of proof URLs, defaulting to `{base}.car` for each content base (A8).
Proof and content hosts may be identical, overlap, or be fully disjoint:

```
https://host/style.json          raw artifact  bafkrei…   (no proof)
https://host/fonts/…             content mirror of the fonts directory
https://host/fonts.car           its proof — anchor bagbaiera…
https://cdn.example/fonts.car    the same proof, byte-identical,
                                 hosted somewhere else entirely
https://mirror.example/fonts/…   a web seed: plain files, no proof
```

Publishing is `cp -r` plus one generated proof file. Mirroring is
`rsync` — a mirror that copies the tree and the `.car` serves both
roles; one that copies only the tree is still a full content source.

A host needs exactly two things beyond static files: HTTPS (browsers
block mixed content) and `Access-Control-Allow-Origin: *`. No `Range`
support, no preflight, no other headers — this is deliberately less than
BitTorrent web seeds demand of a server (A14).

Path segments are percent-encoded per segment when building URLs;
separators stay literal.

### A4. Trust model

Every byte the client uses is authenticated by a chain of sha2-256
equalities rooted in the anchor:

```
anchor (raw) ─▶ file bytes
anchor (car) ─▶ proof bytes ─▶ root CID ─▶ node block (A6)
                                    ─▶ child CID … ─▶ leaf digest ─▶ file bytes
```

Hosts and network are untrusted: they can withhold bytes (denial of
service, visible) but cannot alter any byte undetected — verification
fails closed. A name absent from a verified directory node is an
**authenticated absence**: the client knows the artifact does not contain
that path (an HTTP 404, by contrast, proves nothing).

Whoever builds the proof chooses the DAG, and the anchor commits to that
choice — exact content, exact structure. Two correct proofs of the same
content that differ in block order are different anchors naming the same
artifact, the same way two `.torrent` files of the same data have
different infohashes (A14). Publishers SHOULD build canonically (A9.1) so
one artifact has one anchor.

Clients MUST take anchors only from configuration or from
already-verified content (e.g. a verified style), never from URLs.

### A5. Proof file (CARv1, strict profile)

The proof publishes the DAG's internal nodes — every `dag-pb` block
reachable from the root: directory nodes and multi-leaf file nodes. Leaf
bytes are never in the proof; they live in the mirrored content. The
container is a standard
[CARv1](https://ipld.io/specs/transport/car/carv1/) archive, restricted
to a strict subset a zero-dependency client can parse against a fixed
template:

```
proof   := header section*
header  := varint(58) dag-cbor({ roots: [root], version: 1 })
section := varint(cidLen + blockLen) cid block
```

The header MUST be this exact 59-byte sequence — the canonical dag-cbor
encoding of the map above, which is what standard CAR writers emit; only
the 32-byte root digest varies:

```
3a                        varint: header length 58
a2                        map(2)
  65 726f6f7473           "roots"
  81                      array(1)
    d8 2a                 tag(42) — CID
    58 25 00              bytes(37), multibase-identity prefix
    01 70 12 20 <digest>  CIDv1 · dag-pb · sha2-256 · 32
  67 76657273696f6e       "version"
  01                      1
```

- `root` — the artifact CID: the `dag-pb` CID that `ipfs add -r` printed
  for the file or directory.
- Each section: `cid` is a binary CIDv1, `dag-pb`, sha2-256, digest
  length 32 (36 bytes); `block` is 1–262,144 bytes whose sha2-256 MUST
  equal the CID digest. Any other codec, a digest mismatch, or a
  duplicate section CID rejects — the body is authored, so malformation
  is an authoring error, not transport noise.
- The proof MUST contain every `dag-pb` block reachable from `root`; a
  resolution that needs a missing block rejects the artifact (A7).
  Unreachable extra sections are permitted and ignored.
- Total proof size is ≤ 262,144 bytes — the anchor names a single raw
  block (A2). Builders MUST fail rather than exceed it (A9.1).

The whole body is verified against the anchor with one sha2-256 _before_
parsing, so the container needs no per-frame self-verification. A
verified proof is immutable: cache it by anchor, without expiry, across
sessions. It may come from any proof URL, and equally from any IPFS
gateway by multihash (`{gateway}/ipfs/{anchor-recoded-raw}?format=raw`).

For a raw artifact no proof exists and none is ever fetched.

#### A5.1 Gateway sources (OPTIONAL)

A client MAY use
[trustless-gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
endpoints as additional sources: fetching the proof by multihash as above;
deriving content bases `{gateway}/ipfs/{root}/{path}` once the root is known (a
path gateway serves the mirrored layout byte-identically); or fetching
individual leaves as `{gateway}/ipfs/{leaf}?format=raw` with the same digest
check and 256 KiB cap. Purely additive; dumb hosts remain the normative
mechanism.

### A6. Node rules

A **node block** is the bytes whose sha2-256 equals the digest of the
`dag-pb` CID that referenced them (the proof root, a directory link, or
a file-node link). Node blocks are capped at 256 KiB. The block MUST
decode as [dag-pb](https://ipld.io/specs/codecs/dag-pb/spec/) in strict
form (fields in canonical order, no unknown fields), and its `Data`
field MUST decode as a UnixFS `Data` message. Two node types are
accepted:

**Directory** (`Type` = 1):

- every link: `Name` present, valid UTF-8, 1–255 bytes, no `/`, no NUL,
  not `.` or `..`; `Hash` a CIDv1, sha2-256, digest length 32, codec
  `raw` or `dag-pb`; `Tsize` ignored;
- links sorted strictly ascending by the UTF-8 bytes of `Name` —
  duplicate names unrepresentable, binary search valid (A7);
- the UnixFS fields `Data` (2), `filesize` (3), `blocksizes` (4),
  `hashType` (5), `fanout` (6) MUST be absent.

**File** (`Type` = 2) — appears only for files larger than one chunk:

- ≥ 1 links, each with empty/absent `Name`; `blocksizes` count equals the
  link count; every blocksize ≥ 1; `filesize` present and equal to the
  sum of `blocksizes`; all values < 2⁵³;
- UnixFS `Data` (2), `hashType` (5), `fanout` (6) MUST be absent (no
  inline data — leaves are raw blocks by the import profile, A9);
- each link resolves, in order, to the next `blocksizes[i]` bytes of the
  file: a `raw` CID is a leaf covering exactly that slice; a `dag-pb` CID
  is a nested File node whose `filesize` MUST equal `blocksizes[i]`.
  File-DAG depth is capped at 8.

In both node types `mode` (7) / `mtime` (8) are ignored if present.

Everything else — `Raw`, `Symlink`, `Metadata`, `HAMTShard` types,
CIDv0, non-sha2-256 hashes — rejects. Accepting fewer shapes can only
reject artifacts, never mis-verify them.

Wire reference for zero-dependency decoders (protobuf field · tag byte):
PBNode: `Links` 2·0x12 (repeated, precede Data), `Data` 1·0x0a.
PBLink: `Hash` 1·0x0a, `Name` 2·0x12, `Tsize` 3·0x18 (this order).
UnixFS `Data`: `Type` 1·0x08, `Data` 2·0x12, `filesize` 3·0x18,
`blocksizes` 4·0x20 (repeated varint, unpacked), `hashType` 5·0x28,
`fanout` 6·0x30, `mode` 7·0x38, `mtime` 8·0x42.

### A7. Resolution and verification

A DAG artifact is opened once, lazily — on the first read that needs it:

```
open(anchor):
  bytes ← GET a proof URL              capped at 262,144 bytes
  require sha256(bytes) == anchor.digest
  (root, blocks) ← parse per A5        template, sections, completeness
```

To read path `p` (possibly empty) from an artifact:

```
resolve(p):
  segments ← split p on "/"            each segment nonempty, ≤ 255 bytes,
                                       not "." or "..", count ≤ 32
  cid ← anchor          (raw artifact — any segment rejects)
      | open(anchor).root              (DAG artifact)
  for each segment s:                  descend directories
    node ← nodeBlock(cid)              from the proof; miss rejects (A5)
    require node is Directory          else reject
    link ← node.links[s]               binary search; miss → NotFound
    cid ← link.Hash
  return fileBytes(cid, url(base, walked segments))

fileBytes(cid, url):
  if cid.codec == raw:                 raw artifact, or single-chunk file
    bytes ← GET url                    capped at 262,144 bytes
    require sha256(bytes) == cid.digest
  else:
    node ← nodeBlock(cid)              must be a File node (A6)
    require node.filesize ≤ maxFileBytes
    bytes ← GET url                    exactly node.filesize bytes; a body
                                       shorter or longer rejects
    verify(bytes, node):               slice per blocksizes, recursing
      for each (link i, blocksizes[i]) over consecutive slices:
        raw leaf    → require sha256(slice) == link digest
        nested node → require nodeBlock(...).filesize == blocksizes[i];
                      recurse on the slice
  return bytes
```

- Resolving an empty path on a raw artifact or a dag-pb File artifact
  yields the file itself; on a Directory artifact it rejects (directories
  have no bytes to return).
- One fetch per file, of exactly the stored bytes — zero request
  overhead after the proof, same as an unverified client.
- Transparent HTTP content-encoding is harmless: hashing applies to the
  decoded body, which must be byte-identical to the stored file. (Part 1
  forbids this for ranges — M9; whole-file reads need no such rule.)

**Failure taxonomy.** `VerificationError` — bytes contradict the anchor
(tampered content, a tampered or incomplete proof; fail closed, count it,
try the next source). `NotFound` — authenticated absence (A4); not an
error of the host. Transport errors — retry against the next source.

### A8. Client behavior

- **Configuration.** Per artifact: the anchor (A2), an ordered list of
  content base URLs, and — DAG artifacts only — an ordered list of proof
  URLs, defaulting to `{base}.car` for each content base, in order.
- **Proof loading.** Lazy, at most one successful load per session. Try
  proof URLs in order: an oversized body, hash mismatch, or parse failure
  counts one `rejected` and moves to the next URL; transport errors move
  on without counting. All URLs failing rejects the read; a later read
  retries. Clients SHOULD expose the verified root CID for diagnostics.
- **Content sources.** Base URLs tried in order. A source that failed
  _verification_ served tampered bytes: skip it for the rest of the
  session. A source that failed _transport_ (network, 4xx/5xx) is
  skipped for the current read but stays eligible for later ones —
  hosts recover, tamperers don't (BEP 19 draws the same line, A14).
- **Caching.** All verified data is immutable: cache node blocks and file
  bytes keyed by digest, without expiry, subject to a byte budget (LRU).
  The proof, keyed by anchor, MAY persist across sessions.
- **Bounded unverified reads.** Every fetch is bounded before
  verification (A12).
- **Stats.** Expose `{ verified, rejected }` counters as the map client
  does; one `rejected` is one tampered or corrupt response caught —
  content body or proof body alike.

### A9. Import profile (publisher side)

Artifacts MUST be imported so that clients can rely on A6:

| rule         | value                                                  |
| ------------ | ------------------------------------------------------ |
| CID          | v1, sha2-256, base32                                   |
| leaves       | `raw` blocks (raw-leaves)                              |
| chunker      | fixed-size 256 KiB (recommended; any fixed size works) |
| file DAG     | balanced, ≤ 174 links/node (default importer)          |
| directories  | plain `dag-pb` nodes — **no HAMT sharding**            |
| mode / mtime | omitted (tolerated by clients, but pointless bytes)    |

This is exactly `ipfs add -r --cid-version 1` (raw-leaves is implied)
with default settings, or the equivalent importer library call. HAMT
sharding begins when a directory node would exceed 256 KiB serialized —
roughly 4,000 entries with short names.
Builders MUST fail rather than emit a sharded directory, and publishers
with such trees split them into several artifacts.

#### A9.1 Proof builder

Walk the DAG from the root and emit the A5 profile: the fixed header,
then every reachable `dag-pb` block exactly once — structure only, no
leaves. For a **canonical anchor**, emit depth-first from the root,
parent before children, visiting directory links in name order and file
links in index order, skipping already-emitted CIDs. Determinism is
RECOMMENDED so independent publishers of the same content converge on
the same anchor (A4). Builders MUST fail when the proof would exceed
256 KiB — split the tree into several artifacts (A13).

The anchor is `CIDv1(car, sha2-256(proof))` — a few lines with any
multiformats library, or recode the CID `ipfs add proof.car` prints
(A2). For IPFS publication, pin the artifact root as usual and add the
proof file beside it.

### A10. MapLibre integration (non-normative)

One protocol serves every whole-file resource, registered once:

```js
const fonts = new VerifiedAsset({ cid: FONTS_ANCHOR, source: fontsBase });
const sprite = new VerifiedAsset({
  cid: SPRITE_ANCHOR, // car-codec anchor — a DAG artifact
  source: spriteBase, // dumb mirror: content only
  proof: "https://cdn.example/sprite.car", // proof hosted elsewhere
});
maplibregl.addProtocol("verified", assetProtocol([fonts, sprite]));

const style = new VerifiedAsset({ cid: STYLE_ANCHOR, source: styleUrl });
const map = new maplibregl.Map({
  container: "map",
  style: JSON.parse(new TextDecoder().decode(await style.bytes(""))),
});
```

with, inside the verified `style.json`:

```json
{
  "sources": { "v": { "type": "vector", "url": "pmtiles://<map CID>" } },
  "glyphs": "verified://<fonts anchor>/{fontstack}/{range}.pbf",
  "sprite": "verified://<sprite anchor>/sprite"
}
```

- `verified://{anchor}/{path}` URLs carry the **trust anchor, never the
  location**: the registry maps the anchor to a client instance whose
  URLs come from page configuration. Styles stay host-independent and are
  themselves pinnable artifacts. Anchors embedded in styles stay stable
  across republishes exactly when proofs are built canonically (A9.1).
- Tiles use veritiles unchanged (`pmtiles://` + `VerifiedSource`,
  Part 1).
- MapLibre percent-encodes segments and expands `{fontstack}` to the
  style's comma-joined font list — the artifact must contain a directory
  named for each exact stack requested, as with any static glyph host.
  Adapter policy: a `NotFound` glyph range resolves to an empty response
  (MapLibre tolerates sparse ranges); `NotFound` on styles or sprites,
  and every `VerificationError`, surface as errors.

### A11. Security considerations

- **Unverified inputs** are exactly: HTTP bodies, each bounded (A12) and
  then hash-verified or discarded. Nothing is parsed before it is
  authenticated — the proof is hashed against the anchor before its
  framing is read; content bodies are hashed directly. There is no
  unverified-but-parsed manifest anywhere in this format.
- **No sniffing.** The artifact kind comes from the anchor codec (A2),
  never from response bytes or URLs.
- **Path safety.** Link names and requested segments are validated (A6,
  A7) so no verified or requested name can steer a URL outside `{base}`.
- **Non-goals.** Availability (a host can refuse), freshness (anchors are
  immutable; naming/updates are out of scope — pair with IPNS/DNSLink
  externally if needed), privacy (request patterns reveal what is
  browsed), and confidentiality (assets are public data).

### A12. Limits

| constant                    | value     | where               |
| --------------------------- | --------- | ------------------- |
| raw artifact / proof / node | ≤ 256 KiB | format (A2, A5, A6) |
| `maxFileBytes` (DAG files)  | ≤ 64 MiB  | client, config      |
| link name                   | ≤ 255 B   | format (A6)         |
| path segments               | ≤ 32      | client (A7)         |
| file-DAG depth              | ≤ 8       | client (A6)         |
| integers (sizes)            | < 2⁵³     | format (A6)         |

Format evolution: the anchor-codec table (A2) and the fixed CAR header
template (A5) gate container changes; node-rule extensions (e.g. HAMT
support) are client capabilities gated by the shapes they accept —
CIDs themselves never change meaning.

### A13. Future work

- **Large blocks.** Both anchor kinds name a single raw block, capping
  raw artifacts and proofs at 256 KiB. Oversized _content_ already has a
  path — the importer turns it into a DAG artifact; an oversized _proof_
  does not — trees whose structure exceeds 256 KiB must split into
  several artifacts (A9.1). Lifting either cap needs one of: client-side
  re-import (chunk the fetched bytes under the pinned A9 profile and
  compare the recomputed root — this would make any UnixFS file CID a
  valid anchor), or an incrementally verifiable hash (BLAKE3/bao-style
  subtree proofs), which today's CID profile does not carry. Either also
  fights ecosystem ceilings: bitswap and gateways refuse multi-megabyte
  blocks, so oversized raw blocks would not interoperate with IPFS
  anyway.
- **HAMT-sharded directories** — A9 forbids them; builders fail instead.
- **Multi-root proofs** — one CAR anchoring several artifacts (CARv1's
  `roots` array permits it; the strict template pins exactly one).
- **Streaming verification** — verifying DAG-file slices as they arrive
  instead of after the whole body; the format already permits it (A7
  verifies independent 256 KiB slices), only client behavior changes.
- **Shareable locators** — a magnet-style string bundling anchor, proof
  URLs, and content URLs (the `xt=` / `xs=` / `ws=` split of magnet
  links, A14), so one pasteable value configures a client.

### A14. Prior art: BitTorrent web seeding (non-normative)

This design intentionally mirrors BitTorrent web seeding
([BEP 19](https://www.bittorrent.org/beps/bep_0019.html)): the
`.torrent` file is the root of trust, distributed independently of the
data; any dumb file host serves plain content; the client verifies
pieces against hashes the torrent committed to. The mapping:

| BitTorrent                   | this spec                    |
| ---------------------------- | ---------------------------- |
| infohash (`xt=urn:btih:…`)   | anchor CID (A2)              |
| `.torrent` metainfo          | proof file (A5)              |
| torrent location (`xs=`)     | proof URLs (A8)              |
| `url-list` web seeds (`ws=`) | content base URLs (A3, A8)   |
| v1 flat piece hashes         | UnixFS DAG — a tree per file |

Lessons this spec inherits:

- **Dumb hosts won.** BEP 17 needed a torrent-aware endpoint on the
  server; BEP 19 works with any mirror already serving the plain file.
  Only BEP 19 survived (WebTorrent never implemented BEP 17). A content
  source here is just files (A3).
- **Locations are hints, never identity.** BEP 19 keeps `url-list`
  outside the info dict precisely so URLs cannot affect the infohash;
  here URLs never enter the anchor (A4).
- **Ban on tamper, retry on busy.** A BEP 19 client discards a URL
  permanently on hash mismatch but keeps it through transient errors;
  A8 draws the same line.
- **Per-file trees beat flat pieces.** v1 pieces span file boundaries,
  forcing pad-file hacks and multi-URL piece fetches on web seeds.
  BitTorrent v2 ([BEP 52](https://www.bittorrent.org/beps/bep_0052.html))
  fixed this with a merkle tree per file whose proof material
  (`piece layers`) travels outside the trusted dict and is verified
  against it — structurally this spec's proof file. UnixFS is per-file
  from the start.
- **Merkle proofs vs dumb hosts** was the tension BitTorrent never
  resolved: BEP 30 merkle torrents were explicitly incompatible with
  HTTP seeding and died. Hosting the proof separately — itself
  content-addressed, fetchable from anywhere including gateways — is
  the resolution. The dual of that freedom is that proof availability
  now matters as much as content availability: configure several proof
  URLs (A8, A5.1).
- **Browsers were an afterthought.** WebTorrent's deployment history is
  a catalog of webseed hosts with missing CORS headers, broken `Range`
  handling, and mixed-content blocks — because BEP 19 needs ranged
  reads. Whole-file fetches keep every request here a CORS simple
  request; a host needs only `Access-Control-Allow-Origin: *` and
  HTTPS (A3).

Adjacent designs, for orientation: BLAKE3/bao's _outboard_ encoding
(hash tree in a separate file beside untouched content) and iroh's
verified ranges are the same sidecar idea at finer granularity; the
IPFS trustless gateway verifies but requires protocol-aware hosts —
A5.1 folds those in as optional sources; SRI verifies whole
subresources only after full buffering. The ecosystem's verification
granularity converged on 16 KiB–256 KiB chunks with coalesced requests
— one whole-file request per asset (A7) is the degenerate, politest
case of BEP 19's own "don't request per piece" guidance.
