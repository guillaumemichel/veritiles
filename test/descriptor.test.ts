import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { decodeDescriptor, encodeDescriptor } from '../src/descriptor.ts';
import { encodeMeta, KIND_SHARD } from '../src/proof-format.ts';
import { sha256Bytes } from './helpers/bytes.ts';

const raw = CID.createV1(0x55, Digest.create(0x12, sha256Bytes(Uint8Array.of(1))));
const dagPb = CID.createV1(0x70, Digest.create(0x12, sha256Bytes(Uint8Array.of(2))));
const dagCbor = CID.createV1(0x71, Digest.create(0x12, sha256Bytes(Uint8Array.of(3))));
const meta = encodeMeta([{ kind: KIND_SHARD, length: 10, digest: sha256Bytes(Uint8Array.of(4)) }]);

test('round-trips the raw map descriptor template', () => {
  const value = decodeDescriptor(encodeDescriptor({ mapCidBytes: raw.bytes, topMeta: meta, mapSize: 10 }));
  assert.equal(value.mapCid.codec, 0x55); assert.equal(value.unixfsCid, undefined);
});

test('round-trips the optional UnixFS bridge template', () => {
  const value = decodeDescriptor(encodeDescriptor({ mapCidBytes: raw.bytes, unixfsCidBytes: dagPb.bytes, topMeta: meta, mapSize: 10 }));
  assert.equal(value.unixfsCid!.codec, 0x70);
});

test('rejects dag-pb maps and dag-cbor UnixFS bridges', () => {
  const badMap = encodeDescriptor({ mapCidBytes: dagPb.bytes, topMeta: meta, mapSize: 10 });
  assert.throws(() => decodeDescriptor(badMap), /map CID codec must be raw/);
  const badUnixfs = encodeDescriptor({ mapCidBytes: raw.bytes, unixfsCidBytes: dagCbor.bytes, topMeta: meta, mapSize: 10 });
  assert.throws(() => decodeDescriptor(badUnixfs), /unixfs CID must be raw or dag-pb/);
});

test('rejects non-template keys and trailing bytes', () => {
  const bytes = encodeDescriptor({ mapCidBytes: raw.bytes, topMeta: meta, mapSize: 10 });
  bytes[2] = 0x78;
  assert.throws(() => decodeDescriptor(bytes));
});
