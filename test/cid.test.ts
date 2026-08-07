import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { parseAssetAnchor } from '../src/cid.ts';

const cid = (codec: number) => CID.createV1(codec, Digest.create(0x12, new Uint8Array(32))).toString();
test('asset anchors accept raw and dag-cbor only', () => {
  assert.equal(parseAssetAnchor(cid(0x55)).codec, 0x55);
  assert.equal(parseAssetAnchor(cid(0x71)).codec, 0x71);
  assert.throws(() => parseAssetAnchor(cid(0x70)), /raw or dag-cbor/);
  assert.throws(() => parseAssetAnchor(cid(0x0202)), /raw or dag-cbor/);
});
