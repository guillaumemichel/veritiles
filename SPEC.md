# veritiles — Verified Content over Dumb Hosts

veritiles verifies content fetched from untrusted static hosts. The only trust
input is a CID anchor. A host may withhold bytes, but cannot alter a byte that
passes verification.

| client          | content shape                     | reads       | authenticated format                         |
| --------------- | --------------------------------- | ----------- | -------------------------------------------- |
| `VerifiedFile`  | one large file, such as PMTiles   | byte ranges | DRISL descriptor plus meta/shard proof tree  |
| `VerifiedAsset` | one file or path-addressed bundle | whole files | raw CID or strict MASL bundle in a CARv1 bag |

Hosts need only GET. Publishing is `cp`; mirroring is `rsync`.

## 1. CIDs and anchors

All accepted CIDs are DASL CIDs: CIDv1, lowercase base32 text, sha2-256,
32-byte digest, and codec `raw` (0x55) or `dag-cbor` (0x71). CIDv0,
other multibases, other hashes, `dag-pb` anchors, and `car` anchors reject.

The one exception is a descriptor's `map` (§2.1): a BDASL CID, codec `raw`,
BLAKE3 (0x1e), 32-byte digest. It names a file and is never recomputed by a
client, so every hash a client checks is sha2-256.

| anchor codec | names                           | accepted by     |
| ------------ | ------------------------------- | --------------- |
| `dag-cbor`   | a ranges descriptor             | `VerifiedFile`  |
| `dag-cbor`   | a MASL asset manifest           | `VerifiedAsset` |
| `raw`        | one whole file, at most 256 KiB | `VerifiedAsset` |

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
  "map": <tag-42 raw BLAKE3 CID>,
  "meta": <bytes>,
  "mapSize": <uint < 2^53>
}
```

```
{
  "v": 1,
  "map": <tag-42 raw BLAKE3 CID>,
  "meta": <bytes>,
  "unixfs": <tag-42 raw-or-dag-pb CID>,
  "mapSize": <uint < 2^53>
}
```

`map` is the BLAKE3 hash of the complete file: the file's name, the same for
every packing of it. Clients never compute it; they use it to find content
locations (§5). The anchor names one packing (it changes with the leaf
layout or `unixfs`); `map` names the file. `mapSize` must equal the coverage
of the embedded top `meta`; a mismatch rejects the descriptor. Decoding is
strict: exactly these keys in this order, and trailing bytes reject.

### 2.2 Proof tree

The proof directory has one fixed name and all remaining names are derived:

```
{proof}/root            descriptor
{proof}/{hex}           shard, named by absolute span start
{proof}/{hex}/meta      child meta
{proof}/{hex}/{hex2}    nested shard
```

Names are unpadded lowercase hexadecimal byte offsets. Every proof file below
`root` is located by derivation — the client computes each name from verified
spans — and is hashed against the digest its parent committed before use:

```
shard := (u32le(relativeOffset) digest32)+
meta  := (kind:u8 u64le(length >= 1) digest32)+
```

A shard is at most 64 KiB (1,820 records). A meta is at most 256 KiB (6,393
records). `kind` 0 names a shard; `kind` 1 names a child directory. Meta child
ranges are consecutive prefix sums. All proof files parse exactly to EOF.

### 2.3 Reading

At open, fetch and authenticate `root`, decode it, and retain its top meta.
For a read, descend only the metas and shards covering the requested range.
Each needed leaf is fetched with a single-range `Range` request, grouped with
adjacent uncached leaves where possible. Every slice is sha-256 checked before
any slice from that response is cached. A client may speculatively fetch an
exact requested range while it descends the proof tree, but may adopt it only
once the descended leaf digests verify every slice — all before any is
cached; a mismatch discards the whole speculative response. It should request
a read's covering shards before its speculative range: a shard queued behind
tile bytes delays every slice it covers.

Before `root` verifies, a client may also request `{proof}/0` from the proof
location `root` goes to and, for each read waiting on the open, the exact
requested range from its first configured content location — with the
built-in router only, never a hinted location (§5, §6).
It may use such an early response only in place of the identical request it
makes later to the same location — `0` once the descent derives it as a
shard name, the range as that read's speculative fetch — and checks it
exactly as a fresh response: a failed parent digest is a proof fault, and
leaf digests gate adoption as above. A failed or unused early response is
discarded.

## 3. Assets

### 3.1 Raw assets

A raw anchor represents exactly one file. `bytes("")` GETs the configured URL
whole (at most 256 KiB) and sha-256 checks it against the anchor digest; any
sub-path rejects. Raw assets have no proof URL.

### 3.2 MASL bundles

A bundle anchor is a dag-cbor CID of a strict MASL bundle profile. Its proof
is a CARv1 bag containing the manifest block; optional raw blocks in the bag
may contain asset bytes. The client locates the manifest by the anchor digest
and hashes it against the anchor before decoding; a section's claimed CID and
its position in the bag carry no trust. A proof location may instead serve the
manifest block alone — the anchor's own bytes, as a router names it (§6): a
body that hashes to the anchor is that block, anything else must be a CAR.

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
`size`, and an optional `content-type` (1–255 UTF-8 bytes), in that order;
anything else rejects.

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

Proof bags are CARv1 only. The header is length-skipped and untrusted. Sections
are minimal-varint length-prefixed binary DASL CIDs followed by bytes; section
CIDs are untrusted lookup keys until a selected block is hashed. Duplicate
section digests reject.

Raw sections are 0 to 8 MiB. Dag-cbor sections are 1 byte to 256 KiB. A proof
CAR is bounded by `maxProofBytes` before parsing (default 32 MiB).

## 4. Client behavior

`source` and `proof` locations are hints, never identity. A client takes
every location from a router (§6); the built-in one names the configured
locations first, in order. The default proof location is `{source}.proofs`
for `VerifiedFile` and `{source}.car` for bundle assets. A query-string source
derives nothing: it requires an explicit proof URL, unless an explicit hints
document (§5) supplies the proof location — the defaulted document never
lifts this requirement.

A fetch tries a CID's locations in order: those that have not failed, then a
fresh one from the router, and only once the router has none left, the
demoted ones, least recently failed first. It fails after 16 failed
locations. A ban lasts the client session and holds for the CID whose bytes
the location got wrong: for any other CID that location is only demoted, as
a URL may serve one file and be named for another. A demotion lasts until
the location serves again.

- Proof faults (bad framing, failed parent digest, malformed structure,
  oversized proof) increment `rejected` and fail over to the next proof
  location. A `VerifiedFile` bans the location; a bundle demotes it, so it is
  tried again, after the others, on a later call.
- Content faults (wrong length or digest) increment `rejected`, ban that
  content location, and fail over.
- Transport faults (network error, non-2xx, a `200` to a `Range` request,
  missing derived proof file) do not increment `rejected` and do not ban a
  location: it moves behind the locations that have not failed, least
  recently failed first.

`stats` exposes `{ verified, rejected }`. Verified buffers are immutable,
survive source failover, and every read returns a fresh exact-size copy.

## 5. Routing hints

A hints document is a mutable, untrusted JSON file mapping CIDs to candidate
locations — where the artifact a CID identifies might be right now, so that
location can change without touching the page, the anchors, or any verified
byte. It is outside the root of trust: never hashed or anchored, adding no
integrity and no freshness. Every byte fetched through a hint verifies against
the anchor chain exactly as a configured URL does; a hostile document can
misdirect a request, never alter a result that verifies.

**Format.** A UTF-8 JSON object (clients require no particular `Content-Type`),
with a `hints` map from CID text (§1) to an array of URL strings in
preference order:

```json
{
  "hints": {
    "bafyrei…desc": ["https://node.example/world.pmtiles.proofs"],
    "bafkr4i…map": [
      "https://cdn-a.example/world.pmtiles",
      "./mirror/world.pmtiles"
    ]
  }
}
```

Keys that are not CIDs of §1, and unknown keys at every level, are ignored;
duplicate JSON keys follow `JSON.parse` (the last wins). There is no version
field — additive change rides on ignored unknown keys.

**Entry semantics.** One rule, no roles: a URL under a CID locates the artifact
that CID identifies, and the client's class (§1) fixes the interpretation —

| CID                             | a URL locates            |
| ------------------------------- | ------------------------ |
| dag-cbor anchor, `VerifiedFile` | the proof base directory |
| dag-cbor anchor, bundle         | the proof CAR (or block) |
| raw anchor / bundle `src`       | the whole file           |
| a descriptor's `map`            | the ranged file          |

Resolution is verify-then-locate: a client consults `hints[cid]` only for a CID
it already holds (a configured anchor) or that a verified structure has named —
`hints[anchor]` joins the proof locations at open, `hints[map]` joins a
`VerifiedFile`'s content sources once the descriptor names it, `hints[src]`
gives per-resource whole-file sources once the manifest names it. A hints
document pre-positions locations; it never chooses what is read.

**Attachment.** Hints documents and discovery are a client option. Off, a
client reads only its configured locations and its router's (§6) and fetches
no document, so a page that names its locations carries none of this layer.
veritiles turns them on by default; other readers take them as a plugin,
`hints()`. On, a client option `hints` (string | string[]) references
documents directly, defaulting to `./hints.json` beside the page (the same
convention family as `{source}.proofs`). Every location option is then
optional: the minimal deployment ships only anchors, with a `hints.json`
beside them. These are the built-in router's rules (§6). An explicit document
is consulted for every CID: fetched in the background once the client first
needs a location, it never holds up a configured one, and its URLs widen every
class's failover behind the configured ones. The defaulted document is
consulted only for a CID with nothing configured, so the default costs nothing
on a fully configured client; with no base URL it is treated as absent. A
custom router gets all of this as its `defaults`, read only if it reads them.
Class rules are unchanged — a raw anchor still rejects `proof`, and
`{cid, proof}` alone is valid, its content location coming from the proof
directory's own document.

**Discovery.** Any directory holding published artifacts may carry a
`hints.json` inside itself, so it travels with the data under `rsync`. When a
location class is missing, the client probes `{dir}/hints.json` for each
directory it can derive from a location the page names — configured or
hinted, never one a custom router (§6) found: a directory location itself
(a proof base, a bundle content base), or the containing directory of a file
or query-string location (a content file, a proof CAR, a signed base URL). Probes fire only when a class is
missing, never on the happy path; a 404 is an ordinary transport miss. A
location learned from a document is probed in turn (location → document →
location), the whole chain bounded by the per-client document cap.

**Client behavior.**

- Documents are fetched lazily with a plain GET, bounded to 1 MiB before
  parsing, memoized per client; a fetch or parse failure is retryable.
- Parsing is tolerant: salvage every valid entry, ignore malformed keys,
  values, and URLs individually. Only a non-object document or the size cap
  rejects the whole document.
- Relative URLs resolve against the document's own URL — the final URL after
  redirects — so a copied or redirected hints file is correct on any mirror.
  After resolution the scheme must be `http` or `https` (§7 secure-context
  rules apply), other schemes and URLs over 4,096 UTF-8 bytes are ignored, and
  a trailing `/` is stripped. A URL locating a directory (a `VerifiedFile`
  proof base) is ignored when it carries a query string — derived names cannot
  join it.
- Configured URLs first, then hinted: explicit documents in option order,
  probed documents last, arrays in document order; the first occurrence of an
  exact URL wins; at most 16 hinted URLs per CID survive the merge.
- The hints layer is transport-level: its faults never increment `rejected`
  and never ban. A hinted URL, once merged, is an ordinary source — every §4
  fault rule applies to it unchanged.
- If a needed CID still has no location after configuration, documents, and
  probes, the operation fails naming the CID and the documents fetched; the
  failure is retryable.

| limit                | value             | bounds                                       |
| -------------------- | ----------------- | -------------------------------------------- |
| document body        | 1 MiB             | pre-parse; a larger document is ignored      |
| hinted URLs per CID  | 16                | post-merge, first wins                       |
| URL length           | 4,096 UTF-8 bytes | per URL, longer ignored                      |
| documents per client | 16                | explicit + probed; past the cap, probes skip |

The load-bearing choices (non-normative): a role-free `CID → [url]` map, since
the codec separates content from proof structure and a CID's class already
fixes what a URL locates; JSON, not DRISL, because the document is never hashed;
no version field, no dependants map, no size flag; in-directory `hints.json`
discovery only. A misread document wastes requests at worst — the same power a
hostile document already holds — so nothing in this layer fails closed.

## 6. Routers

A router finds where a CID's bytes may live at runtime — a content-routing
index, a gateway, a lookup table. A client takes every location from one: the
built-in router reads the page's own configuration (§4) and, with hints on,
hints documents (§5); a custom router replaces it:

```
router.locate(cid, { defaults }) → URLs, best first, as an async iterable
router.fetch(url, init, context) → Promise<Response>      (optional)
```

A function alone is shorthand for `{ locate }`. `locate` receives a CID in
canonical text form (§1) and yields absolute URLs; an array, or a promise of
one, is read as well. `defaults` yields what the built-in router would for the
same CID — configured locations, then, with hints on, hinted, then probed —
and is read only if the router reads it. A custom router is authoritative, and the order it
yields in is its strategy: the page's own locations first and its own after,
its own first, or whichever come first. Like a hints document, a router is
outside the root of trust: every byte fetched from a location it yields
verifies against the anchor chain exactly as a configured one, so a hostile
router can misdirect a request, never alter a result that verifies.

**Entry semantics.** A located URL is the URL of the CID's own bytes. This is
the rule of [FISL](https://dasl.ing/fisl.html), so an index that speaks it
answers as is:

| CID                             | a URL locates                  | the client reads                         |
| ------------------------------- | ------------------------------ | ---------------------------------------- |
| dag-cbor anchor, `VerifiedFile` | the descriptor, `{proof}/root` | the proof tree beside it                 |
| dag-cbor anchor, bundle         | the manifest block (§3.2)      | the manifest; a CAR there is read as one |
| raw anchor / bundle `src`       | the whole file                 | the file                                 |
| a descriptor's `map`            | the ranged file                | its byte ranges                          |

Proof names derive from `root`'s directory (§2.2), so a `VerifiedFile` anchor
URL whose path does not end in `/root`, or that carries a query string, is
skipped. Lookups are verify-then-locate, as for hints: `locate` is called for
an anchor at open, for `map` once the descriptor names it, and for a `src`
once the manifest names it; a file already verified needs no location.

**Reading.**

- A client reads a CID's locations lazily and keeps them for its session. A
  fetch takes the next value only when no location it holds is left to try
  (§4); concurrent fetches share one read, and a speculative range (§2.3)
  uses the held locations only.
- A value that is not an absolute `http` or `https` URL of at most 4,096
  UTF-8 bytes is skipped, a trailing `/` is stripped, and the first
  occurrence of a location wins. A value `defaults` yielded passes as it is,
  since a page may configure relative or other-scheme locations.
- A router that throws ends its stream, as does reading 64 values from one
  call. Once the stream has ended and every location failed, the next fetch
  calls `locate` again.

**Transport.** A router with `fetch` carries every request to every location
of every CID, `defaults`' included, and answers as `fetch` would. Its context
names the CID read (the anchor for proof files and a raw file, the map for
its byte ranges, the `src` for a bundle file), the location as yielded (`{proof}/root` for
every file of that proof tree), `next` (the client's own fetch), and
`verdict`, a promise of what became of the response:

| verdict    | the response                                                                          |
| ---------- | ------------------------------------------------------------------------------------- |
| `verified` | passed verification and was used                                                      |
| `rejected` | failed verification (§4); a speculative body is only passed over, its range refetched |
| `failed`   | failed in transport (§4)                                                              |
| `unused`   | was dropped unjudged: aborted, or sent early and not needed by the first read         |

A router thereby learns which hosts serve, how fast, and which serve bad
bytes, and it may add credentials to a request or refuse one. With a custom
router, a `VerifiedFile` sends no early range (§2.3): the map has no location
before the descriptor verifies.

| limit                      | value             | bounds                  |
| -------------------------- | ----------------- | ----------------------- |
| values read per `locate`   | 64                | skipped values included |
| failed locations per fetch | 16                | then the fetch fails    |
| URL length                 | 4,096 UTF-8 bytes | per URL, longer ignored |

## 7. Hosts

| requirement                                               | why                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET` for files and proofs                                | all paths                                                                             |
| exact single `Range` response (`206`)                     | `VerifiedFile` content reads only                                                     |
| HTTPS or localhost                                        | WebCrypto secure context                                                              |
| CORS allowing GET; allow `Range` on OPTIONS when required | cross-origin embedding                                                                |
| a URL's bytes never change                                | content is content-addressed — new content is a new CID and URL; hints move locations |

Proof hosts never require `Range`. Asset hosts never require `Range`.
`VerifiedFile` content responses must use identity encoding: transparent
compression changes bytes and therefore fails verification.

Hints documents (§5) relax this: any `Content-Type` is acceptable, transparent
compression is allowed (they are never hashed), and — being mutable — they
should carry a modest `Cache-Control` (minutes to hours), not `immutable`.
Because they are routinely fetched cross-origin, CORS must allow GET.

## 8. Publishing

The reference packer is a repository development tool; it is not part of the
published client library package. Run it from a clone of this repository after
`npm ci`. A Rust port in `packer/` (`npm run pack:rs`) writes the same bytes
for files too large for the TypeScript packer's in-memory read.

```
npm run pack -- world.pmtiles
npm run pack -- world.pmtiles --unixfs --full-car world.car
npm run pack -- assets ./public --out assets.car
```

The default ranges pack writes `world.pmtiles.proofs/` and prints a dag-cbor
descriptor anchor. `--unixfs` embeds a reproducible UnixFS root CID in the
descriptor (§2.1) — the standard 256 KiB fixed-chunk `ipfs add --cid-version 1`
layout — and `--full-car` also writes that DAG as a CAR for `ipfs dag import`.
The CAR's blocks are in DAG post-order (children left to right, then their
parent), each block once at its first occurrence, so the same file always
yields the same CAR bytes.

A PMTiles archive gets one leaf per tile group: contiguous tiles merged up to
`--tile-group` bytes, cut at every section boundary and banded by zoom. By
default the packer picks the smallest of 16, 32 and 64 KiB that lets the
descriptor's top meta list every shard directly — a reader then reaches any
shard without a directory round trip — else 64 KiB, and prints the budget it
used. A band with more shards than the top meta has room for splits into
subdirectories of at most 399 shards (child metas of at most 16 KiB), each
listed in the top meta. The tree's shape is the packer's choice; readers
follow whatever metas the descriptor names (§2.2).

A fragmented MP4 (an `ftyp` box first, then a top-level `moof`) gets one
leaf per fragment, in one band, from a walk over its top-level ISO BMFF
boxes: everything before the first fragment (`ftyp`, `moov`, a global
`sidx`) is one leaf; each fragment — its `moof` and `mdat` boxes, with any
`styp`, `emsg` or `prft` boxes before the `moof` — is one leaf; boxes after
the last `mdat` (an `mfra`) form a last leaf. A player that reads each
fragment at the range its `sidx` lists fetches exactly one leaf.

`pack assets <dir>` writes a MASL CAR, the manifest block alone beside it
(`bundle.car` → `bundle.masl`: the file a router names for the anchor, §6), and
prints its dag-cbor manifest anchor.
When the directory's unique file contents total at most 256 KiB, every file
travels in the CAR as a raw section, each distinct block once. Otherwise the
CAR carries the manifest alone and files are fetched whole from the content
base, verified against the manifest's raw `src` CID.

## 9. IPFS and DASL interoperability

DASL/atproto compatibility is the primary format rule: anchors, manifest
links, and CAR sections accepted by clients are raw or dag-cbor CIDs only.
The optional descriptor `unixfs` value is deliberately an opaque IPFS bridge:
clients never fetch, decode, or verify it — it only names the same bytes in
the UnixFS ecosystem so publishers can pin and announce them with standard
tooling.

Small raw assets and manifest blocks are already valid IPFS blocks by their
own CIDs, so a MASL CAR imports into standard IPFS tooling unchanged.

A stock IPFS gateway is therefore an ordinary host. Its deserialized endpoint
serves the file's bytes at `/ipfs/<unixfs-cid>` with `Range` support — dag-pb
is internal DAG structure, not what goes over the wire — so gateway responses
verify against the proof tree like any mirror's. Adding the proof directory
(`ipfs add -r world.pmtiles.proofs`) puts a whole deployment behind one
gateway; a configured `source`/`proof`, or a hints document, carries the
gateway URLs:

```json
{
  "hints": {
    "bafyrei…desc": ["https://gw.example/ipfs/bafybei…proofs"],
    "bafkr4i…map": ["https://gw.example/ipfs/bafybei…unixfs"]
  }
}
```

Hints keys stay the CIDs of §1 (§5): the client looks up only CIDs it already
holds or has verified, and the dag-pb CID rides inside the URL value, which
is opaque to it. §7 host rules apply unchanged — the deserialized endpoint
(never `?format=raw`), identity encoding, CORS, and `Range` + `206` on the
content file.

## 10. Non-goals

Availability, freshness, confidentiality, and privacy of access patterns are
non-goals: a host can withhold service; anchors never change (pair a naming
layer such as IPNS or DNSLink for updates); content is public data.
