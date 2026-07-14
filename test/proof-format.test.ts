import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeMeta,
  KIND_DIR,
  KIND_SHARD,
  MAX_SHARD_RECORDS,
  SHARD_RECORD_SIZE,
  shardLeavesFor,
  shardName,
  validateShard,
} from '../src/proof-format.ts';
import { toHex, VerificationError } from '../src/verify.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { encodeMeta, encodeShard } from './helpers/proof-encode.ts';

const digest = (seed: number) => deterministicBytes(32, seed);

test('shardName is 16 zero-padded lowercase hex digits', () => {
  assert.equal(shardName(0), '0000000000000000');
  assert.equal(shardName(0xa3f0c0), '0000000000a3f0c0');
});

test('shard records round-trip: fixed 36 B records, offsets relative to the filename', () => {
  const bytes = encodeShard(
    [
      { offset: 5000, digest: digest(1) },
      { offset: 15565, digest: digest(2) },
      { offset: 15660, digest: digest(3) },
    ],
    5000,
  );
  assert.equal(bytes.length, 3 * SHARD_RECORD_SIZE);
  const span = 10565 + 95 + 145136;
  assert.equal(validateShard(bytes, span, 'shard'), 3);
  assert.deepEqual(shardLeavesFor(bytes, 5000, span), [
    { offset: 5000, length: 10565, digest: toHex(digest(1)) },
    { offset: 15565, length: 95, digest: toHex(digest(2)) },
    { offset: 15660, length: 145136, digest: toHex(digest(3)) },
  ]);
});

test('shard range query bisects to exactly the covering leaves', () => {
  const bytes = encodeShard(
    [
      { offset: 1000, digest: digest(1) },
      { offset: 1100, digest: digest(2) },
      { offset: 1300, digest: digest(3) },
    ],
    1000,
  ); // leaves [1000,1100) [1100,1300) [1300,1600) under span 600

  assert.deepEqual(shardLeavesFor(bytes, 1000, 600, 1100, 1101), [
    { offset: 1100, length: 200, digest: toHex(digest(2)) },
  ]);
  assert.deepEqual(
    shardLeavesFor(bytes, 1000, 600, 1099, 1101).map((l) => l.offset),
    [1000, 1100],
  );
  // Half-open: a range ending exactly at a leaf's start excludes that leaf.
  assert.deepEqual(
    shardLeavesFor(bytes, 1000, 600, 1000, 1100).map((l) => l.offset),
    [1000],
  );
  assert.deepEqual(
    shardLeavesFor(bytes, 1000, 600, 1500, 1600).map((l) => l.offset),
    [1300],
  );
});

test('shard validation rejects malformed structure', () => {
  const good = encodeShard(
    [
      { offset: 0, digest: digest(4) },
      { offset: 100, digest: digest(5) },
    ],
    0,
  );
  assert.equal(validateShard(good, 150, 's'), 2);

  assert.throws(() => validateShard(new Uint8Array(0), 100, 's'), /empty/);
  assert.throws(() => validateShard(concat(good, Uint8Array.of(7)), 150, 's'), /multiple of 36/);
  // Last record starting at 100 needs a span > 100 to cover ≥ 1 byte.
  assert.throws(() => validateShard(good, 100, 's'), /outside the 100-byte span/);
  const notFirst = new Uint8Array(good);
  notFirst[0] = 1;
  assert.throws(() => validateShard(notFirst, 150, 's'), /first record/);
  const dup = new Uint8Array(good);
  dup[SHARD_RECORD_SIZE] = 0; // second record's offset back to 0
  assert.throws(() => validateShard(dup, 150, 's'), /ascending/);
  const oversize = new Uint8Array((MAX_SHARD_RECORDS + 1) * SHARD_RECORD_SIZE);
  assert.throws(() => validateShard(oversize, 1e9, 's'), /record limit/);
  assert.throws(() => shardLeavesFor(good.subarray(1), 0, 150), /not validated/);

  // The test encoder enforces the same rules.
  assert.throws(() => encodeShard([], 0), /empty/);
  assert.throws(() => encodeShard([{ offset: 5, digest: digest(6) }], 0), /first record/);
  assert.throws(
    () =>
      encodeShard(
        [
          { offset: 0, digest: digest(6) },
          { offset: 0, digest: digest(7) },
        ],
        0,
      ),
    /ascending/,
  );
  assert.throws(() => encodeShard([{ offset: 2 ** 32, digest: digest(6) }], 0), /u32/);
});

test('meta entries round-trip with kinds and prefix-summed ranges', () => {
  const entries = [
    { kind: KIND_SHARD, length: 60000, digest: digest(5) },
    { kind: KIND_DIR, length: 4_000_000, digest: digest(6) },
  ];
  const { entries: decoded, covered } = decodeMeta(encodeMeta(entries), 100);
  assert.deepEqual(decoded, [
    { kind: KIND_SHARD, start: 100, length: 60000, digest: toHex(digest(5)) },
    { kind: KIND_DIR, start: 60100, length: 4_000_000, digest: toHex(digest(6)) },
  ]);
  assert.equal(covered, 60000 + 4_000_000);
});

test('meta range decode returns only covering entries, coverage stays whole-file', () => {
  const bytes = encodeMeta([
    { kind: KIND_SHARD, length: 500, digest: digest(5) },
    { kind: KIND_DIR, length: 700, digest: digest(6) },
  ]); // entries at [0,500) [500,1200)

  const tail = decodeMeta(bytes, 0, 800, 900);
  assert.deepEqual(
    tail.entries.map((e) => e.start),
    [500],
  );
  assert.equal(tail.covered, 1200);

  const outside = decodeMeta(bytes, 0, 5000, 6000);
  assert.deepEqual(outside.entries, []);
  assert.equal(outside.covered, 1200);
});

test('meta rejects unknown kinds and malformed records', () => {
  const good = encodeMeta([{ kind: KIND_SHARD, length: 10, digest: digest(7) }]);
  const badKind = new Uint8Array(good);
  badKind[0] = 2;
  assert.throws(() => decodeMeta(badKind, 0), /unknown entry kind/);
  assert.throws(() => decodeMeta(good.subarray(0, 10), 0), /multiple of 41/);
  assert.throws(() => decodeMeta(new Uint8Array(0), 0), /empty/);

  // A range length at 2^53 (hi u32 = 0x200000) is past integer precision.
  const overflow = new Uint8Array(good);
  overflow.set(Uint8Array.of(0, 0, 0, 0, 0, 0, 0x20, 0), 1);
  assert.throws(() => decodeMeta(overflow, 0), /exceeds 2\^53/);

  // A zero length is unrepresentable coverage.
  const zero = new Uint8Array(good);
  zero.set(new Uint8Array(8), 1);
  assert.throws(() => decodeMeta(zero, 0), /zero-length/);

  assert.throws(() => decodeMeta(overflow, 0), VerificationError);
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
