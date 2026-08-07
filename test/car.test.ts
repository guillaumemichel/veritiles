import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { parseCarBag } from '../src/car.ts';
import { DAG_CBOR_SECTION_CAP } from '../src/limits.ts';
import { craftCar, rawSection, frameSection, wrapCarV2 } from './helpers/car.ts';
import { sha256Bytes } from './helpers/bytes.ts';

const root = CID.createV1(0x71, Digest.create(0x12, sha256Bytes(Uint8Array.of(1))));

test('parses raw and dag-cbor CARv1 sections', () => {
  const block = Uint8Array.of(1, 2); const car = craftCar(root, [{ cidBytes: root.bytes, block: Uint8Array.of(1) }, rawSection(block)]);
  assert.equal(parseCarBag(car, 'proof').size, 2);
});

test('rejects CARv2, dag-pb, and oversized dag-cbor sections', () => {
  assert.throws(() => parseCarBag(wrapCarV2(craftCar(root, [])), 'proof'));
  const dagPb = CID.createV1(0x70, Digest.create(0x12, sha256Bytes(Uint8Array.of(1))));
  assert.throws(() => parseCarBag(craftCar(root, [{ cidBytes: dagPb.bytes, block: Uint8Array.of(1) }]), 'proof'));
  const cid = CID.createV1(0x71, Digest.create(0x12, new Uint8Array(32)));
  assert.throws(() => parseCarBag(craftCar(root, [{ cidBytes: cid.bytes, block: new Uint8Array(DAG_CBOR_SECTION_CAP + 1) }]), 'proof'));
});

test('rejects duplicate section digests', () => {
  const section = rawSection(Uint8Array.of(2)); const header = craftCar(root, []);
  assert.throws(() => parseCarBag(new Uint8Array([...header, ...frameSection(section), ...frameSection(section)]), 'proof'));
});
