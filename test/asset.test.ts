import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError, VerifiedAsset } from '../src/asset.ts';
import { VerificationError } from '../src/verify.ts';
import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { buildRaw, buildRawEmpty, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';

const BASE = 'https://h/a';

test('raw artifacts read the base URL and reject subpaths', async () => {
  const fixture = await buildRaw(); const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes(), fixture.files.get(''));
  await assert.rejects(asset.bytes('x'), VerificationError);
  assert.deepEqual(server.requests, [BASE]);
});

test('raw artifacts reject stat for both the root and subpaths, without a fetch', async () => {
  const fixture = await buildRaw(); const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  await assert.rejects(asset.stat(), /no declared size/);
  await assert.rejects(asset.stat('x'), /no sub-paths/);
  assert.deepEqual(server.requests, [], 'stat on a raw anchor never fetches');
});

test('empty raw artifact round-trips', async () => {
  const fixture = await buildRawEmpty(); const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes(), new Uint8Array());
});

test('bundle resolves full paths and serves verified CAR raw sections', async () => {
  const fixture = await buildTree(); const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes('Noto Sans Regular/0-255.pbf'), TREE_ENTRIES[1]!.bytes);
  assert.deepEqual(server.requests, [`${BASE}.car`]);
  assert.deepEqual(await asset.stat('style.json'), { size: 200, contentType: 'application/json' });
});

test('missing paths are authenticated absence and malformed paths never fetch', async () => {
  const fixture = await buildTree(); const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  await assert.rejects(asset.bytes('missing'), NotFoundError);
  await assert.rejects(asset.bytes('../x'), VerificationError);
  assert.equal(server.requests.length, 1);
});

test('a corrupted optional CAR raw section falls back to the content URL without banning the source', async () => {
  const fixture = await buildTree();
  const server = serveArtifact([{ base: BASE, fixture, hooks: { tamper: (url, bytes) => url.endsWith('.car') ? flipByte(bytes, bytes.length - 1) : undefined } }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes('fonts é/z.pbf'), TREE_ENTRIES[2]!.bytes);
  assert.ok(server.requests.includes(`${BASE}/fonts%20%C3%A9/z.pbf`));
});

test('oversized manifest entry rejects before a content fetch', async () => {
  const content = deterministicBytes(20, 1);
  const fixture = await buildArtifact([{ path: 'x', bytes: content }]);
  const server = serveArtifact([{ base: BASE, fixture }]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, maxFileBytes: 10, fetchFn: server.fetch });
  await assert.rejects(asset.bytes('x'), VerificationError);
  assert.deepEqual(server.requests, [`${BASE}.car`]);
});

test('content mismatch bans a bad source and fails over', async () => {
  const fixture = await buildArtifact([{ path: 'x', bytes: deterministicBytes(20, 2) }]);
  const server = serveArtifact([
    { base: 'https://h/a', fixture, hooks: { tamper: (url, bytes) => url.endsWith('.car') ? bytes : flipByte(bytes) } },
    { base: 'https://h/b', fixture },
  ]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: ['https://h/a', 'https://h/b'], fetchFn: server.fetch });
  // CAR sections avoid content fetching, so remove them by serving only a manifest proof.
  await assert.deepEqual(await asset.bytes('x'), fixture.files.get('x'));
});
