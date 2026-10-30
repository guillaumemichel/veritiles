// Strict DRISL (CBOR/c) primitives shared by the descriptor and MASL manifest.

import { type Cid, decodeCidBytes } from './cid.ts';
import { VerificationError } from './verify.ts';

export interface TextString { text: string; bytes: Uint8Array; encoded: Uint8Array; }

export function uint(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  const b = bytes[cursor.pos];
  if (b === undefined) throw new VerificationError(`${label}: truncated integer`);
  if (b <= 0x17) { cursor.pos++; return b; }
  const widths: [number, number][] = [[0x18, 1], [0x19, 2], [0x1a, 4], [0x1b, 8]];
  for (let i = 0; i < widths.length; i++) {
    const [marker, width] = widths[i]!;
    if (b !== marker) continue;
    if (cursor.pos + 1 + width > bytes.length) throw new VerificationError(`${label}: truncated integer`);
    let value = 0;
    for (let j = 0; j < width; j++) value = value * 0x100 + bytes[cursor.pos + 1 + j]!;
    if (!Number.isSafeInteger(value)) throw new VerificationError(`${label}: integer exceeds 2^53`);
    const min = i === 0 ? 24 : 2 ** (8 * widths[i - 1]![1]);
    if (value < min) throw new VerificationError(`${label}: non-canonical integer`);
    cursor.pos += 1 + width;
    return value;
  }
  throw new VerificationError(`${label}: not an unsigned integer`);
}

export function byteString(bytes: Uint8Array, cursor: { pos: number }, label: string): Uint8Array {
  const length = valueHead(bytes, cursor, 2, label);
  if (cursor.pos + length > bytes.length) throw new VerificationError(`${label}: truncated byte string`);
  const out = bytes.subarray(cursor.pos, cursor.pos + length);
  cursor.pos += length;
  return out;
}

export function textString(bytes: Uint8Array, cursor: { pos: number }, label: string): TextString {
  const start = cursor.pos;
  const length = valueHead(bytes, cursor, 3, label);
  if (cursor.pos + length > bytes.length) throw new VerificationError(`${label}: truncated text string`);
  const raw = bytes.subarray(cursor.pos, cursor.pos + length);
  cursor.pos += length;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), bytes: raw, encoded: bytes.subarray(start, cursor.pos) };
  } catch {
    throw new VerificationError(`${label}: invalid UTF-8 text string`);
  }
}

export function mapHead(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  return valueHead(bytes, cursor, 5, label);
}

export function tag42Cid(bytes: Uint8Array, cursor: { pos: number }, label: string): Cid {
  for (const want of [0xd8, 0x2a, 0x58, 0x25, 0x00]) {
    if (bytes[cursor.pos++] !== want) throw new VerificationError(`${label}: not a tag-42 CID`);
  }
  return decodeCidBytes(bytes, cursor, label);
}

export function encodeUint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`bad uint ${value}`);
  if (value < 24) return Uint8Array.of(value);
  if (value < 0x100) return Uint8Array.of(0x18, value);
  if (value < 0x10000) return Uint8Array.of(0x19, value >> 8, value & 0xff);
  if (value < 0x100000000) return Uint8Array.of(0x1a, value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const out = new Uint8Array(9);
  out[0] = 0x1b;
  for (let i = 0; i < 8; i++) out[8 - i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
  return out;
}

export const encodeBytesHead = (length: number): Uint8Array => encodeHead(length, 2);
export const encodeTextHead = (length: number): Uint8Array => encodeHead(length, 3);
export const encodeMapHead = (count: number): Uint8Array => encodeHead(count, 5);

export function encodeTag42(cid: Cid): Uint8Array {
  if (cid.bytes.length !== 36) throw new Error('CID must be 36 binary bytes');
  return Uint8Array.of(0xd8, 0x2a, 0x58, 0x25, 0x00, ...cid.bytes);
}

function valueHead(bytes: Uint8Array, cursor: { pos: number }, major: number, label: string): number {
  const b = bytes[cursor.pos];
  const kind = major === 2 ? 'byte string' : major === 3 ? 'text string' : 'map';
  if (b === undefined) throw new VerificationError(`${label}: truncated ${kind}`);
  const base = major << 5;
  if (b >= base && b <= base + 23) { cursor.pos++; return b - base; }
  if (b !== base + 24 && b !== base + 25) throw new VerificationError(`${label}: not a ${kind}`);
  const width = b === base + 24 ? 1 : 2;
  if (cursor.pos + 1 + width > bytes.length) throw new VerificationError(`${label}: truncated ${kind}`);
  let length = 0;
  for (let i = 0; i < width; i++) length = length * 0x100 + bytes[cursor.pos + 1 + i]!;
  if (length < (width === 1 ? 24 : 0x100)) throw new VerificationError(`${label}: non-canonical ${kind}`);
  cursor.pos += 1 + width;
  return length;
}

function encodeHead(length: number, major: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff) throw new Error(`bad CBOR length ${length}`);
  const base = major << 5;
  if (length < 24) return Uint8Array.of(base + length);
  if (length < 0x100) return Uint8Array.of(base + 24, length);
  return Uint8Array.of(base + 25, length >> 8, length & 0xff);
}
