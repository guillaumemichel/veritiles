// Minimal ISO BMFF writer for the `mp4` profile's tests: top-level boxes
// with a 32-bit size, a 64-bit largesize, or size 0 (the box runs to the end
// of the file), and bare headers with any size field for malformed files.
// Payloads are opaque: the packer reads box headers only.

import { deterministicBytes } from './bytes.ts';

/** Payload bytes, or a length for that many deterministic bytes. */
export type Payload = Uint8Array | number;

/** A box with a 32-bit size. */
export function box(type: string, payload: Payload = 0): Uint8Array {
  const body = bytesOf(payload);
  return concat(header(type, 8 + body.length), body);
}

/** A box with size 1 and a 64-bit largesize after the type. */
export function largeBox(type: string, payload: Payload = 0): Uint8Array {
  const body = bytesOf(payload);
  return concat(header(type, 1, BigInt(16 + body.length)), body);
}

/** A box with size 0, which runs to the end of the file: put it last. */
export function openBox(type: string, payload: Payload = 0): Uint8Array {
  return concat(header(type, 0), bytesOf(payload));
}

/** One fragment: a `moof` and an `mdat` with payloads of these lengths. */
export function fragment(moof: number, mdat: number): Uint8Array {
  return concat(box('moof', moof), box('mdat', mdat));
}

/** A bare box header: any 32-bit size field, then a largesize when given. */
export function header(type: string, size: number, largesize?: bigint): Uint8Array {
  if (type.length !== 4) throw new Error(`box type must be 4 characters: ${type}`);
  const out = new Uint8Array(largesize === undefined ? 8 : 16);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  if (largesize !== undefined) view.setBigUint64(8, largesize);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesOf(payload: Payload): Uint8Array {
  return typeof payload === 'number' ? deterministicBytes(payload, payload + 1) : payload;
}
