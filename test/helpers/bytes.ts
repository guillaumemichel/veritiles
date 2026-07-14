// Deterministic byte fixtures shared by every suite.

import { createHash } from 'node:crypto';

// xorshift32-based deterministic bytes so fixtures never depend on RNG state.
export function deterministicBytes(length: number, seed = 42): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function flipByte(bytes: Uint8Array, index = 0): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index]! ^= 0xff;
  return copy;
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// xorshift32 PRNG for shuffles and sizes in randomized-but-reproducible tests.
export function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}
