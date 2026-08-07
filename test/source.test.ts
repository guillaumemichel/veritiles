// VerifiedSource suite: the pmtiles Source adapter over a VerifiedFile — the
// key is the bare anchor, getBytes returns an exact-size unshared buffer,
// and a failed open stays retryable.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedSource } from '../src/index.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { buildProofPackage } from './helpers/package.ts';
import { servePackage } from './helpers/serve-file.ts';

const FILE = 'https://tiles.example/map.pmtiles';
const bytes = deterministicBytes(5 * 262144, 50);
const cuts = Array.from({ length: 5 }, () => 262144);
const pkg = await buildProofPackage({ mapBytes: bytes, cuts });

function open(opts: { proofDown?: () => boolean } = {}) {
  const { fetch, requests } = servePackage(FILE, bytes, pkg.proofs, {
    proofStatus: () => (opts.proofDown?.() ? 503 : undefined),
  });
  return { source: new VerifiedSource({ cid: pkg.anchor, source: FILE, fetchFn: fetch }), requests };
}

test('S-01 getKey returns the bare anchor CID', () => {
  const { source } = open();
  assert.equal(source.getKey(), pkg.anchor);
});

test('S-02 getBytes returns an exact-size, unshared buffer with no cache metadata', async () => {
  const { source } = open();
  const res = await source.getBytes(0, 1000);
  assert.equal(res.data.byteLength, 1000);
  assert.equal(res.etag, undefined);
  assert.equal(res.expires, undefined);
  assert.deepEqual(new Uint8Array(res.data), bytes.subarray(0, 1000));
  const res2 = await source.getBytes(262144, 10);
  assert.equal(res2.data.byteLength, 10);
});

test('S-03 a failed open is retryable', async () => {
  let down = true;
  const { source } = open({ proofDown: () => down });
  await assert.rejects(source.ready());
  down = false;
  await source.ready(); // memo cleared; retry succeeds
  const res = await source.getBytes(0, 100);
  assert.deepEqual(new Uint8Array(res.data), bytes.subarray(0, 100));
});
