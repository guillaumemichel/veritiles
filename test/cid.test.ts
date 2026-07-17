import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import * as Digest from 'multiformats/hashes/digest';

import {
  assertNodeLinkCid,
  CAR_CODE,
  DAG_PB_CODE,
  decodeCidBytes,
  formatCidV1,
  parseAnchorCid,
  parseCid,
  RAW_CODE,
  rawLeafCidBytes,
  SHA2_256_CODE,
} from '../src/cid.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { buildBig, buildRaw } from './helpers/fixtures.ts';

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
  const root = 'bafybeihnila5l5dabqrbpvaictnce5wop364y5kbc7kfowbnd5mbnpayci';
  const parsed = parseCid(root, 'root');
  assert.equal(parsed.codec, DAG_PB_CODE);
  assert.equal(parsed.hashCode, SHA2_256_CODE);
  assert.equal(parsed.digest.length, 32);
  assert.deepEqual(parsed.bytes, CID.parse(root).bytes);
});

// --- A1: anchors and binary CIDs (A2) ---

test('C-01 parseAnchorCid accepts a raw anchor', async () => {
  const raw = await buildRaw();
  const cid = parseAnchorCid(raw.anchor);
  assert.equal(cid.codec, RAW_CODE);
});

test('C-02 parseAnchorCid accepts a car anchor (multi-byte codec varint)', async () => {
  const big = await buildBig();
  const cid = parseAnchorCid(big.anchor);
  assert.equal(cid.codec, CAR_CODE);
  assert.equal(cid.digest.length, 32);
});

test('C-03 parseAnchorCid rejects a dag-pb CID — old-model anchors fail loudly', () => {
  const dagPbRoot = 'bafybeihnila5l5dabqrbpvaictnce5wop364y5kbc7kfowbnd5mbnpayci';
  assert.throws(() => parseAnchorCid(dagPbRoot), VerificationError);
});

test('C-04 parseAnchorCid rejects a CIDv0', () => {
  assert.throws(() => parseAnchorCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), /not multibase base32/);
});

test('C-05 parseAnchorCid rejects non-base32 multibases and uppercase', async () => {
  const good = (await buildRaw()).anchor;
  assert.throws(() => parseAnchorCid(good.toUpperCase()), /not multibase base32/); // 'B' upper
  assert.throws(() => parseAnchorCid(`z${good.slice(1)}`), /not multibase base32/); // base58btc
  assert.throws(() => parseAnchorCid(`f${good.slice(1)}`), VerificationError); // base16
  assert.throws(() => parseAnchorCid(`u${good.slice(1)}`), VerificationError); // base64url
});

test('C-06 parseAnchorCid rejects sha2-512 and truncated-digest CIDs', () => {
  const sha512 = CID.createV1(RAW_CODE, Digest.create(0x13, deterministicBytes(64, 21)));
  assert.throws(() => parseAnchorCid(sha512.toString()), /sha2-256/);
  // A raw CID that declares a 32-byte digest but only carries 4 bytes.
  const truncated = base32.encode(Uint8Array.of(1, RAW_CODE, SHA2_256_CODE, 32, 1, 2, 3, 4));
  assert.throws(() => parseAnchorCid(truncated), /digest length mismatch/);
});

test('C-07 parseAnchorCid rejects garbage, over-long varints, empty, non-string', () => {
  assert.throws(() => parseAnchorCid('b!!!!'), /invalid base32 character/);
  assert.throws(
    () => parseAnchorCid(base32.encode(Uint8Array.of(1, 0x80, 0x80, 0x80, 0x80, 0x80, 1))),
    /varint too long/,
  );
  assert.throws(() => parseAnchorCid(''), /not multibase base32/);
  assert.throws(() => parseAnchorCid(42), /not a string/);
});

test('C-08 decodeCidBytes reads an embedded CID and lands exactly after it', () => {
  const embedded = CID.createV1(RAW_CODE, Digest.create(SHA2_256_CODE, deterministicBytes(32, 22)));
  const buf = new Uint8Array(3 + embedded.bytes.length + 4);
  buf.set([0xaa, 0xbb, 0xcc], 0);
  buf.set(embedded.bytes, 3);
  buf.set([0xde, 0xad, 0xbe, 0xef], 3 + embedded.bytes.length);
  const cursor = { pos: 3 };
  const cid = decodeCidBytes(buf, cursor, 'link');
  assert.equal(cid.codec, RAW_CODE);
  assert.deepEqual(cid.digest, deterministicBytes(32, 22));
  assert.deepEqual(cid.bytes, embedded.bytes);
  assert.equal(cursor.pos, 3 + embedded.bytes.length); // exactly after the CID
});

test('C-09 decodeCidBytes rejects version ≠ 1 and truncated digests', () => {
  assert.throws(
    () => decodeCidBytes(Uint8Array.of(2, RAW_CODE, SHA2_256_CODE, 32), { pos: 0 }, 'link'),
    /not version 1/,
  );
  assert.throws(
    () => decodeCidBytes(Uint8Array.of(1, RAW_CODE, SHA2_256_CODE, 32, 1, 2, 3), { pos: 0 }, 'link'),
    /truncated CID digest/,
  );
});

test('C-10 assertNodeLinkCid: raw and dag-pb ok; car and identity reject', () => {
  const link = (codec: number) => ({ codec, hashCode: SHA2_256_CODE, digest: deterministicBytes(32, 23), bytes: new Uint8Array() });
  assert.doesNotThrow(() => assertNodeLinkCid(link(RAW_CODE), 'link'));
  assert.doesNotThrow(() => assertNodeLinkCid(link(DAG_PB_CODE), 'link'));
  assert.throws(() => assertNodeLinkCid(link(CAR_CODE), 'link'), /codec must be raw or dag-pb/);
  assert.throws(() => assertNodeLinkCid(link(0x00), 'link'), /codec must be raw or dag-pb/);
});

test('C-11 formatCidV1(CAR_CODE, digest) matches multiformats', () => {
  const digest = deterministicBytes(32, 24);
  const expected = CID.createV1(CAR_CODE, Digest.create(SHA2_256_CODE, digest)).toString();
  assert.equal(formatCidV1(CAR_CODE, digest), expected);
});
