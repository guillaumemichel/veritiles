// Binary proof formats — the client-side (decode/validate) half of the wire
// spec; publishers encode these with the build tooling. Every file is a
// plain sequence of records and must parse to exactly EOF; a truncated or
// trailing byte rejects the whole file. Digests are raw 32-byte sha2-256
// outputs (the algorithm is declared once in metadata.json, "hash"); every
// integer is fixed-width little-endian.
//
//   shard file := ( u32le(relativeOffset) digest32 )+          fixed 36 B records
//   meta file  := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+ fixed 41 B records
//
// Shard records are fixed-size so a fetched shard is binary-searchable in
// place: the digest-verified buffer IS the client's index — no parsing, no
// derived structures. Offsets are relative to the shard's absolute start
// (its filename), which bounds them by the shard's span: shard files are
// hard-capped at 64 KiB (1,820 records), and with leaves ≤ 1 MiB the span
// fits u32 with headroom. Records must start at 0 and ascend strictly; each
// covers until the next (the last until the span the parent meta committed),
// so gaps and zero-length leaves are unrepresentable.
//
// Meta records carry range lengths, no offsets: entries are file-contiguous,
// so absolute positions are prefix sums from the directory's range start.
// Lengths are u64le because an entry's range is bounded only by publisher
// tree shape (u32 would cap it at 4 GiB); values are still rejected at 2^53,
// where JS numbers lose integer precision. Meta kinds: 0 = shard file named
// shardName(start); 1 = subdirectory named shardName(start), whose entries
// live in its own `<name>/meta`.

import { toHex, VerificationError } from './verify.ts';

export const DIGEST_LENGTH = 32;
export const SHARD_RECORD_SIZE = 4 + DIGEST_LENGTH;
export const SHARD_FILE_CAP = 64 * 1024; // hard limit on shard file size
export const MAX_SHARD_RECORDS = Math.floor(SHARD_FILE_CAP / SHARD_RECORD_SIZE);
export const META_RECORD_SIZE = 1 + 8 + DIGEST_LENGTH;
export const KIND_SHARD = 0;
export const KIND_DIR = 1;

// A verified byte range of the map file and the digest its bytes must hash to.
export interface Leaf {
  offset: number;
  length: number;
  digest: string;
}

export interface MetaEntry {
  kind: number;
  start: number;
  length: number;
  digest: string;
}

// Filename convention: 16 lowercase hex digits of the absolute start offset.
export function shardName(startOffset: number): string {
  return startOffset.toString(16).padStart(16, '0');
}

// Structural check, once per fetched shard (the bytes are already
// digest-verified): record framing, first record at the shard's own start,
// strict ascent, and the last record inside the span the parent committed.
// Returns the record count.
export function validateShard(bytes: Uint8Array, spanLength: number, label: string): number {
  if (bytes.length === 0) throw new VerificationError(`${label}: empty shard`);
  if (bytes.length % SHARD_RECORD_SIZE !== 0) {
    throw new VerificationError(
      `${label}: size ${bytes.length} not a multiple of ${SHARD_RECORD_SIZE}`,
    );
  }
  if (bytes.length > MAX_SHARD_RECORDS * SHARD_RECORD_SIZE) {
    throw new VerificationError(`${label}: exceeds the ${MAX_SHARD_RECORDS}-record limit`);
  }
  const count = bytes.length / SHARD_RECORD_SIZE;
  let prev = -1;
  for (let i = 0; i < count; i++) {
    const rel = relOffsetAt(bytes, i);
    if (i === 0 && rel !== 0) {
      throw new VerificationError(`${label}: first record must start the shard`);
    }
    if (rel <= prev) throw new VerificationError(`${label}: offsets not strictly ascending`);
    prev = rel;
  }
  if (prev >= spanLength) {
    throw new VerificationError(`${label}: record at ${prev} outside the ${spanLength}-byte span`);
  }
  return count;
}

// Covering leaves for [start, end) straight off a validated shard buffer:
// binary search on the fixed-size records, then materialize (and hex) only
// the overlapping ones. A record covers until the next; the last covers to
// spanLength, the range its parent meta committed.
export function shardLeavesFor(
  bytes: Uint8Array,
  startOffset: number,
  spanLength: number,
  start = 0,
  end = Infinity,
): Leaf[] {
  const count = bytes.length / SHARD_RECORD_SIZE;
  if (count === 0 || !Number.isInteger(count)) {
    throw new VerificationError('shard not validated');
  }
  const relStart = start - startOffset;
  const relEnd = end - startOffset;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (relOffsetAt(bytes, mid + 1) <= relStart) lo = mid + 1;
    else hi = mid;
  }
  const leaves: Leaf[] = [];
  for (let i = lo; i < count; i++) {
    const rel = relOffsetAt(bytes, i);
    if (rel >= relEnd) break;
    const next = i + 1 < count ? relOffsetAt(bytes, i + 1) : spanLength;
    const pos = i * SHARD_RECORD_SIZE + 4;
    leaves.push({
      offset: startOffset + rel,
      length: next - rel,
      digest: toHex(bytes.subarray(pos, pos + DIGEST_LENGTH)),
    });
  }
  return leaves;
}

function relOffsetAt(bytes: Uint8Array, index: number): number {
  const pos = index * SHARD_RECORD_SIZE;
  return (
    bytes[pos]! + bytes[pos + 1]! * 0x100 + bytes[pos + 2]! * 0x10000 + bytes[pos + 3]! * 0x1000000
  );
}

// -> { entries, covered }. Same range semantics as shardLeavesFor: only
// entries overlapping [start, end) are materialized; `covered` sums every
// entry. Entry starts are prefix sums from startOffset (the directory's
// range start; 0 for the top directory).
export function decodeMeta(
  bytes: Uint8Array,
  startOffset: number,
  start = 0,
  end = Infinity,
): { entries: MetaEntry[]; covered: number } {
  if (bytes.length === 0) throw new VerificationError('meta: empty file');
  if (bytes.length % META_RECORD_SIZE !== 0) {
    throw new VerificationError(`meta: size ${bytes.length} not a multiple of ${META_RECORD_SIZE}`);
  }
  const entries: MetaEntry[] = [];
  let offset = startOffset;
  for (let pos = 0; pos < bytes.length; pos += META_RECORD_SIZE) {
    const kind = bytes[pos]!;
    if (kind !== KIND_SHARD && kind !== KIND_DIR) {
      throw new VerificationError(`meta: unknown entry kind ${kind}`);
    }
    const length = readU64(bytes, pos + 1, 'meta');
    if (length === 0) throw new VerificationError('meta: zero-length range');
    if (offset + length > start && offset < end) {
      const at = pos + 9;
      entries.push({
        kind,
        start: offset,
        length,
        digest: toHex(bytes.subarray(at, at + DIGEST_LENGTH)),
      });
    }
    offset += length;
  }
  return { entries, covered: offset - startOffset };
}

// u64le onto a JS number. Rejects values at 2^53, where numbers lose integer
// precision — every length in scope is a file size, far below.
function readU64(bytes: Uint8Array, pos: number, label: string): number {
  const lo =
    bytes[pos]! + bytes[pos + 1]! * 0x100 + bytes[pos + 2]! * 0x10000 + bytes[pos + 3]! * 0x1000000;
  const hi =
    bytes[pos + 4]! +
    bytes[pos + 5]! * 0x100 +
    bytes[pos + 6]! * 0x10000 +
    bytes[pos + 7]! * 0x1000000;
  if (hi >= 0x200000) throw new VerificationError(`${label}: value exceeds 2^53`);
  return lo + hi * 0x100000000;
}
