import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import * as dagCbor from '@ipld/dag-cbor';

import { decodeManifest, encodeManifest, pathKey, splitPath } from '../src/manifest.ts';
import { sha256Bytes } from './helpers/bytes.ts';

const src = CID.createV1(0x55, Digest.create(0x12, sha256Bytes(Uint8Array.of(1))));
const entry = { src: { codec: src.code, hashCode: src.multihash.code, digest: src.multihash.digest, bytes: src.bytes }, size: 1, contentType: 'text/plain' };

test('manifest round-trips and is decodable by dag-cbor', () => {
  const bytes = encodeManifest([['/b', entry], ['/a', entry]], { withType: true });
  const manifest = decodeManifest(bytes);
  assert.equal(manifest.entries.size, 2);
  assert.deepEqual((dagCbor.decode(bytes) as { resources: Record<string, unknown> }).resources['/a'], { src, size: 1, 'content-type': 'text/plain' });
});

test('manifest path helpers use the same request validation', () => {
  assert.deepEqual(splitPath('a/b'), ['a', 'b']); assert.equal(pathKey([]), '/');
  assert.throws(() => splitPath('a//b'));
  assert.throws(() => encodeManifest([['bad', entry]]));
});

test('manifest rejects malformed top-level and entry CIDs', () => {
  assert.throws(() => decodeManifest(Uint8Array.of(0xa0)));
  const bad = CID.createV1(0x71, Digest.create(0x12, sha256Bytes(Uint8Array.of(2))));
  assert.throws(() => encodeManifest([['/x', { ...entry, src: { codec: bad.code, hashCode: bad.multihash.code, digest: bad.multihash.digest, bytes: bad.bytes } }]]));
});
