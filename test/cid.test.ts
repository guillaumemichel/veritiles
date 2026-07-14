import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import * as Digest from 'multiformats/hashes/digest';

import { DAG_PB_CODE, formatCidV1, parseCid, RAW_CODE, rawLeafCidBytes, SHA2_256_CODE } from '../src/cid.ts';
import { deterministicBytes } from './helpers/bytes.ts';

const digest = (seed: number) => deterministicBytes(32, seed);
const referenceCid = (codec: number, d: Uint8Array) => CID.createV1(codec, Digest.create(SHA2_256_CODE, d));

test('parses CIDs produced by the canonical multiformats stack', () => {
  // 0x0200 (json) exercises a multi-byte codec varint.
  for (const codec of [RAW_CODE, DAG_PB_CODE, 0x0200]) {
    for (const seed of [1, 2, 3]) {
      const reference = referenceCid(codec, digest(seed));
      const parsed = parseCid(reference.toString(), 'test');
      assert.equal(parsed.codec, codec);
      assert.equal(parsed.hashCode, SHA2_256_CODE);
      assert.deepEqual(parsed.digest, digest(seed));
      assert.deepEqual(parsed.bytes, reference.bytes);
    }
  }
});

test('formatCidV1 round-trips through the canonical text form', () => {
  for (const codec of [RAW_CODE, DAG_PB_CODE]) {
    assert.equal(formatCidV1(codec, digest(7)), referenceCid(codec, digest(7)).toString());
  }
});

test('rawLeafCidBytes matches the canonical binary CID', () => {
  assert.deepEqual(rawLeafCidBytes(digest(9)), referenceCid(RAW_CODE, digest(9)).bytes);
});

test('rejects every non-canonical or malformed text form', () => {
  const good = referenceCid(DAG_PB_CODE, digest(1)).toString();
  const cases: [unknown, RegExp][] = [
    [42, /not a string/],
    [null, /not a string/],
    ['', /not multibase base32/],
    ['b', /not multibase base32/],
    ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', /not multibase base32/], // CIDv0
    [`z${good.slice(1)}`, /not multibase base32/], // base58btc multibase
    [good.toUpperCase(), /not multibase base32/], // multibase 'B' (upper) unsupported
    [`b${good.slice(1).toUpperCase()}`, /invalid base32 character/],
    [good.replace(/.$/, '!'), /invalid base32 character/],
    [good.replace(/.$/, '0'), /invalid base32 character/], // 0 not in RFC4648 base32
    ['bb', /non-canonical base32 padding/], // 5 bits, low bit set
    [good.slice(0, 10), /digest length mismatch|truncated CID/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => parseCid(text, 'test'), expected, String(text));
  }
});

test('rejects structurally wrong binary CIDs', () => {
  const encode = (bytes: Uint8Array) => base32.encode(bytes); // 'b' + base32
  // Wrong version.
  assert.throws(
    () => parseCid(encode(Uint8Array.of(2, RAW_CODE, SHA2_256_CODE, 2, 1, 2)), 'test'),
    /not a CIDv1|not version 1/,
  );
  // Digest shorter than declared.
  assert.throws(
    () => parseCid(encode(Uint8Array.of(1, RAW_CODE, SHA2_256_CODE, 32, 1, 2, 3)), 'test'),
    /digest length mismatch/,
  );
  // Digest longer than declared.
  assert.throws(
    () => parseCid(encode(Uint8Array.of(1, RAW_CODE, SHA2_256_CODE, 1, 1, 2)), 'test'),
    /digest length mismatch/,
  );
  // Truncated mid-varint.
  assert.throws(() => parseCid(encode(Uint8Array.of(1, 0x80)), 'test'), /truncated CID/);
  // Varint over the 5-byte cap.
  assert.throws(
    () => parseCid(encode(Uint8Array.of(1, 0x80, 0x80, 0x80, 0x80, 0x80, 1)), 'test'),
    /varint too long/,
  );
});

test('accepts the real demo package root', () => {
  const root = 'bafybeidromswvzgmm4hwagh6yn3ktbf2wajgfmt3zcqkt4oofmqw4wfkja';
  const parsed = parseCid(root, 'root');
  assert.equal(parsed.codec, DAG_PB_CODE);
  assert.equal(parsed.hashCode, SHA2_256_CODE);
  assert.equal(parsed.digest.length, 32);
  assert.deepEqual(parsed.bytes, CID.parse(root).bytes);
});
