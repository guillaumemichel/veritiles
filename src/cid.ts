// Minimal CIDv1 handling — the zero-dependency replacement for the one CID
// shape this format uses: CIDv1 in its canonical text form (multibase
// base32, lowercase). A parsed CID keeps its raw binary form for CBOR links
// and CAR sections; anything unexpected fails closed as a VerificationError.
// CIDv0 and other multibases are deliberately not supported: the reference
// builder emits canonical CIDv1 base32 everywhere, and accepting fewer
// encodings can only reject packages, never mis-verify them.

import { VerificationError } from './verify.ts';

export const RAW_CODE = 0x55;
export const DAG_PB_CODE = 0x70;
export const DAG_CBOR_CODE = 0x71;
export const SHA2_256_CODE = 0x12;

export interface Cid {
  codec: number;
  hashCode: number;
  digest: Uint8Array;
  /** The full binary CID, exactly as embedded in CBOR links and CAR sections. */
  bytes: Uint8Array;
}

// The ranges-path anchor gate (PLAN-shards §1.1): a CIDv1, base32, sha2-256,
// 32-byte digest, codec dag-cbor — the proof descriptor block. Anything else
// rejects; clients MUST NOT sniff bodies to decide.
export function parseFileAnchor(text: unknown): Cid {
  const cid = parseCid(text, 'anchor');
  if (cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) {
    throw new VerificationError('anchor: CID must be sha2-256 with a 32-byte digest');
  }
  if (cid.codec !== DAG_CBOR_CODE) {
    throw new VerificationError('anchor: CID codec must be dag-cbor (a proof descriptor)');
  }
  return cid;
}

// The assets-path anchor gate (SPEC §2): a CIDv1, base32, sha2-256, 32-byte
// digest whose codec is the CONTENT's own root — raw (one-chunk content) or
// dag-cbor (a MASL manifest). Anything else rejects; clients MUST NOT sniff
// bodies to decide.
export function parseAssetAnchor(text: unknown): Cid {
  const cid = parseCid(text, 'anchor');
  if (cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) {
    throw new VerificationError('anchor: CID must be sha2-256 with a 32-byte digest');
  }
  if (cid.codec !== RAW_CODE && cid.codec !== DAG_CBOR_CODE) {
    throw new VerificationError('anchor: CID codec must be raw or dag-cbor');
  }
  return cid;
}

// Decode one binary CIDv1 embedded in a larger byte stream (a CBOR link or CAR
// section), reading at `cursor` and leaving it positioned exactly
// after the CID's last digest byte. The returned `bytes` is the CID slice.
export function decodeCidBytes(bytes: Uint8Array, cursor: { pos: number }, label: string): Cid {
  const start = cursor.pos;
  const version = readVarint(bytes, cursor, label);
  if (version !== 1) throw new VerificationError(`${label}: CID is not version 1`);
  const codec = readVarint(bytes, cursor, label);
  const hashCode = readVarint(bytes, cursor, label);
  const digestLength = readVarint(bytes, cursor, label);
  const digestStart = cursor.pos;
  const digestEnd = digestStart + digestLength;
  if (digestEnd > bytes.length) {
    throw new VerificationError(`${label}: truncated CID digest`);
  }
  cursor.pos = digestEnd;
  return {
    codec,
    hashCode,
    digest: bytes.subarray(digestStart, digestEnd),
    bytes: bytes.subarray(start, digestEnd),
  };
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

// Unsigned LEB128, capped at 5 bytes (< 2^35) — far above any multicodec.
export function readVarint(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
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
