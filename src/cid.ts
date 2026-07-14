// Minimal CIDv1 handling — the zero-dependency replacement for the one CID
// shape this format uses: CIDv1 in its canonical text form (multibase
// base32, lowercase). A parsed CID keeps its raw binary form for dag-pb
// link encoding; anything unexpected fails closed as a VerificationError.
// CIDv0 and other multibases are deliberately not supported: the reference
// builder emits canonical CIDv1 base32 everywhere, and accepting fewer
// encodings can only reject packages, never mis-verify them.

import { VerificationError } from './verify.ts';

export const RAW_CODE = 0x55;
export const DAG_PB_CODE = 0x70;
export const SHA2_256_CODE = 0x12;

export interface Cid {
  codec: number;
  hashCode: number;
  digest: Uint8Array;
  /** The full binary CID, exactly as embedded in dag-pb links. */
  bytes: Uint8Array;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE32.length; i++) BASE32_VALUE[BASE32.charCodeAt(i)] = i;

export function parseCid(text: unknown, label: string): Cid {
  if (typeof text !== 'string') {
    throw new VerificationError(`${label}: CID is not a string`);
  }
  if (text.length < 2 || !text.startsWith('b')) {
    throw new VerificationError(`${label}: CID is not multibase base32`);
  }
  const bytes = base32Decode(text.slice(1), label);
  const cursor = { pos: 0 };
  const version = readVarint(bytes, cursor, label);
  if (version !== 1) throw new VerificationError(`${label}: CID is not version 1`);
  const codec = readVarint(bytes, cursor, label);
  const hashCode = readVarint(bytes, cursor, label);
  const digestLength = readVarint(bytes, cursor, label);
  const digest = bytes.subarray(cursor.pos);
  if (digest.length !== digestLength) {
    throw new VerificationError(`${label}: CID digest length mismatch`);
  }
  return { codec, hashCode, digest, bytes };
}

// Binary CIDv1 for a raw sha2-256 leaf — how the client links the manifest
// bytes it hashed itself (all four prefix varints are single bytes).
export function rawLeafCidBytes(sha256Digest: Uint8Array): Uint8Array {
  return cidV1Bytes(RAW_CODE, sha256Digest);
}

// Canonical text form of a CIDv1 over a sha2-256 digest — error messages
// only, so mismatches read like the CIDs users configured.
export function formatCidV1(codec: number, sha256Digest: Uint8Array): string {
  return `b${base32Encode(cidV1Bytes(codec, sha256Digest))}`;
}

function cidV1Bytes(codec: number, digest: Uint8Array): Uint8Array {
  if (codec > 0x7f) throw new VerificationError(`unsupported codec ${codec}`);
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([1, codec, SHA2_256_CODE, digest.length]);
  bytes.set(digest, 4);
  return bytes;
}

// RFC 4648 base32, lowercase, no padding (multibase 'b'). Strict: unknown
// characters and non-zero trailing bits reject, so every accepted string
// has exactly one byte interpretation.
function base32Decode(text: string, label: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let value = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < BASE32_VALUE.length ? BASE32_VALUE[code]! : -1;
    if (v < 0) throw new VerificationError(`${label}: invalid base32 character`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) {
    throw new VerificationError(`${label}: non-canonical base32 padding`);
  }
  return out;
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Unsigned LEB128, capped at 5 bytes (< 2^35) — far above any multicodec.
function readVarint(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (cursor.pos >= bytes.length) {
      throw new VerificationError(`${label}: truncated CID`);
    }
    const byte = bytes[cursor.pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
  }
  throw new VerificationError(`${label}: CID varint too long`);
}
