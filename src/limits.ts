// The SPEC.md limits as named constants — the single source of the
// numeric bounds every module fails closed against. Format limits (block and
// section caps, integer ceiling) are wire rules; client limits (proof body,
// cache budget, path shape) are configurable defaults.

// Format (SPEC §3.2, §3.3): per-codec block caps and the shared integer ceiling.
export const DAG_CBOR_SECTION_CAP = 256 * 1024; // a dag-cbor block: 1 B .. 256 KiB
export const MANIFEST_CAP = 256 * 1024; // a complete MASL manifest block
export const RAW_SECTION_CAP = 2 ** 23; // a raw section block: 0 B .. 8 MiB

// Ranges-path bounds (SPEC §2).
export const MAX_LEAF_BYTES = 2 ** 23; // a single verified leaf: 8 MiB

// VerifiedFile client defaults.
export const DEFAULT_MAX_PROOF_BYTES = 32 * 2 ** 20; // unverified proof body (SPEC §3.3)
export const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024; // verified-byte LRU budget
export const DESCRIPTOR_CAP = 256 * 1024; // {proof}/root body — bounds the embedded top meta
export const PROOF_CACHE_BYTES = 8 * 1024 * 1024; // proof-file LRU budget (metas ≤ 256 KiB, shards ≤ 64 KiB)

// Routing-hints limits (SPEC §5), fixed rather than configurable. The document
// is untrusted, so these bound waste, never integrity.
export const MAX_HINT_BYTES = 2 ** 20; // one document body, pre-parse: 1 MiB
export const MAX_HINT_URLS_PER_CID = 16; // hinted URLs kept per CID, post-merge
export const MAX_HINT_DOCS = 16; // documents fetched per client (explicit + probed)
export const MAX_HINT_URL_BYTES = 4096; // one hinted URL, UTF-8 bytes; longer ignored

// VerifiedAsset client defaults (whole-file resources).
export const ASSET_WHOLE_CAP = 262144; // a raw artifact / single whole-file read: 256 KiB
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024; // a bundle file body bound
export const MAX_SEGMENTS = 32; // request path segment count (SPEC §3.2)
export const MAX_NAME = 255; // path / link name UTF-8 bytes (SPEC §3.2)
export const MAX_PATH_BYTES = 4096; // manifest path key UTF-8 bytes
