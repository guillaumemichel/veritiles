// Proof file parser — CARv1, strict profile (A5). The proof publishes every
// dag-pb node reachable from the artifact root; leaves live in the mirrored
// content, not here. The container is a standard CARv1 archive restricted to a
// fixed subset a zero-dependency client can parse against a byte-for-byte
// header template. The whole body is hash-verified against the anchor BEFORE
// this runs (A5), so `parseProof` never sees unauthenticated bytes; it only
// checks that the authored structure is well-formed.

import { type Cid, DAG_PB_CODE, decodeCidBytes, SHA2_256_CODE } from './cid.ts';
import { equalBytes, sha256, toHex, VerificationError } from './verify.ts';

// The format cap: a raw artifact, a proof file, and a node block are each a
// single raw block of at most 256 KiB (A2, A5, A6).
export const BLOCK_CAP = 262144;

// The fixed 59-byte header (A5): an 18-byte prefix, the 32-byte root digest,
// a 9-byte suffix — the canonical dag-cbor of `{roots:[root],version:1}` that
// standard CAR writers emit. Only the digest varies; any other byte rejects.
const HEADER_PREFIX = Uint8Array.of(
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
);
const HEADER_SUFFIX = Uint8Array.of(0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01);
const HEADER_LENGTH = 59;
const CID_OFFSET = 14; // where `01 70 12 20 <digest>` begins inside the prefix

// A dag-pb sha2-256 CIDv1 is exactly 36 bytes, so a section (CID + ≥1 block
// byte) is at least 37 bytes and at most 36 + a full block.
const MIN_SECTION = 37;
const MAX_SECTION = 36 + BLOCK_CAP;

export async function parseProof(
  bytes: Uint8Array,
  label: string,
): Promise<{ root: Cid; blocks: Map<string, Uint8Array> }> {
  if (bytes.length < HEADER_LENGTH) {
    throw new VerificationError(`${label}: proof shorter than the 59-byte header`);
  }
  if (!equalBytes(bytes.subarray(0, HEADER_PREFIX.length), HEADER_PREFIX)) {
    throw new VerificationError(`${label}: proof header prefix does not match the template`);
  }
  if (!equalBytes(bytes.subarray(HEADER_LENGTH - HEADER_SUFFIX.length, HEADER_LENGTH), HEADER_SUFFIX)) {
    throw new VerificationError(`${label}: proof header suffix does not match the template`);
  }
  const root = decodeCidBytes(bytes, { pos: CID_OFFSET }, `${label}: root`);

  const blocks = new Map<string, Uint8Array>();
  const cursor = { pos: HEADER_LENGTH };
  while (cursor.pos < bytes.length) {
    const length = readSectionLength(bytes, cursor, label);
    if (length < MIN_SECTION || length > MAX_SECTION) {
      throw new VerificationError(`${label}: section length ${length} out of range`);
    }
    const sectionEnd = cursor.pos + length;
    if (sectionEnd > bytes.length) {
      throw new VerificationError(`${label}: section runs past end of proof`);
    }
    const cidCursor = { pos: cursor.pos };
    const cid = decodeCidBytes(bytes, cidCursor, `${label}: section CID`);
    if (cid.codec !== DAG_PB_CODE || cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) {
      throw new VerificationError(`${label}: section CID must be dag-pb with sha2-256`);
    }
    const block = bytes.subarray(cidCursor.pos, sectionEnd);
    if (!equalBytes(await sha256(block), cid.digest)) {
      throw new VerificationError(`${label}: section block does not match its CID digest`);
    }
    const key = toHex(cid.digest);
    if (blocks.has(key)) throw new VerificationError(`${label}: duplicate section`);
    blocks.set(key, block);
    cursor.pos = sectionEnd;
  }
  return { root, blocks };
}

// The CAR framing varint. Unsigned LEB128, rejecting non-minimal encodings —
// a trailing all-zero group could always be shorter (CARv1 requires canonical
// varints).
function readSectionLength(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  let value = 0;
  let count = 0;
  for (let shift = 0; shift < 64; shift += 7) {
    if (cursor.pos >= bytes.length) throw new VerificationError(`${label}: truncated section length`);
    const byte = bytes[cursor.pos++]!;
    count++;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (count > 1 && byte === 0) throw new VerificationError(`${label}: non-minimal section length`);
      if (!Number.isSafeInteger(value)) throw new VerificationError(`${label}: section length too large`);
      return value;
    }
  }
  throw new VerificationError(`${label}: section length varint too long`);
}
