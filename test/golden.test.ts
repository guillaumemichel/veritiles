// Golden compatibility: the fixture is the first 64 KiB of a REAL PMTiles
// world extract. Its MAP CID is byte-stable and identical to what kubo 0.41
// prints for `ipfs add --cid-version 1 -Q --chunker size-16384` — the
// descriptor's content binding. The anchor (dag-cbor descriptor CID) is
// frozen below; if the zero-dependency CID / descriptor / proof code ever
// drifts, this fails.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { VerifiedSource } from '../src/index.ts';
import { decodeDescriptor } from '../src/descriptor.ts';
import { decodeMeta, KIND_SHARD } from '../src/proof-format.ts';
import { buildProofPackage } from './helpers/package.ts';
import { servePackage } from './helpers/serve-file.ts';
import { sha256Bytes } from './helpers/bytes.ts';


const headBytes = new Uint8Array(await readFile(new URL('./fixtures/golden/map.head.bin', import.meta.url)));
const cuts = [16384, 16384, 16384, 16384];
const pkg = await buildProofPackage({ mapBytes: headBytes, cuts });

test('G-01 the real archive head binds its raw whole-file CID', () => {
  assert.equal(pkg.mapCid, CID.createV1(0x55, Digest.create(0x12, sha256Bytes(headBytes))).toString());
  assert.equal(pkg.leaves.length, cuts.length);
  let expected = 0;
  for (const leaf of pkg.leaves) {
    assert.equal(leaf.offset, expected, 'leaves partition the head exactly');
    expected += leaf.length;
  }
  assert.equal(expected, headBytes.length);
});

test('G-02 the descriptor anchor is content-addressed and well-formed', () => {
  assert.equal(pkg.anchor, CID.createV1(0x71, Digest.create(0x12, sha256Bytes(pkg.descriptor))).toString());
  const d = decodeDescriptor(pkg.descriptor);
  assert.equal(d.mapSize, headBytes.length);
  const { entries, covered } = decodeMeta(d.topMeta, 0);
  assert.equal(covered, headBytes.length);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, KIND_SHARD);
});

test('G-03 the packed head reads back byte-identical through VerifiedSource', async () => {
  const { fetch } = servePackage('https://h/map.pmtiles', headBytes, pkg.proofs);
  const source = new VerifiedSource({ cid: pkg.anchor, source: 'https://h/map.pmtiles', fetchFn: fetch });
  await source.ready();
  const res = await source.getBytes(0, headBytes.length);
  assert.deepEqual(new Uint8Array(res.data), headBytes);
  assert.equal(source.stats.rejected, 0);
  assert.ok(source.stats.verified >= pkg.leaves.length);
});
