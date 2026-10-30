import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { parseAssetAnchor, tryParseCid } from '../packages/core/src/cid.ts';

const cid = (codec: number) => CID.createV1(codec, Digest.create(0x12, new Uint8Array(32))).toString();
test('asset anchors accept raw and dag-cbor only', () => {
  assert.equal(parseAssetAnchor(cid(0x55)).codec, 0x55);
  assert.equal(parseAssetAnchor(cid(0x71)).codec, 0x71);
  assert.throws(() => parseAssetAnchor(cid(0x70)), /raw or dag-cbor/);
  assert.throws(() => parseAssetAnchor(cid(0x0202)), /raw or dag-cbor/);
});

const b3 = (codec: number) => CID.createV1(codec, Digest.create(0x1e, new Uint8Array(32))).toString();
test('hint keys accept sha2-256 raw/dag-cbor and BLAKE3 raw only', () => {
  assert.equal(tryParseCid(cid(0x55))?.hashCode, 0x12);
  assert.equal(tryParseCid(cid(0x71))?.hashCode, 0x12);
  assert.equal(tryParseCid(b3(0x55))?.hashCode, 0x1e);
  assert.equal(tryParseCid(b3(0x71)), null);
  assert.equal(tryParseCid(cid(0x70)), null);
});

test('anchors stay sha2-256: a BLAKE3 anchor rejects', () => {
  assert.throws(() => parseAssetAnchor(b3(0x55)), /sha2-256/);
});
