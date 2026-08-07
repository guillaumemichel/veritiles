import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCid } from '../src/cid.ts';
import { ProofSource } from '../src/proof-source.ts';
import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { TREE_ENTRIES } from './helpers/fixtures.ts';

test('proof source decodes and memoizes an anchored manifest', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES); const server = serveArtifact([{ base: 'https://h/a', fixture }]);
  const stats = { verified: 0, rejected: 0 };
  const source = new ProofSource(['https://h/a.car'], { fetchFn: server.fetch, maxProofBytes: 1024 * 1024, stats });
  const root = await source.root(parseCid(fixture.anchor, 'anchor'));
  assert.equal(root.entries.size, TREE_ENTRIES.length);
  await source.root(parseCid(fixture.anchor, 'anchor'));
  assert.deepEqual(stats, { verified: 1, rejected: 0 });
  assert.deepEqual(server.requests, ['https://h/a.car']);
});

test('missing roots fail over to the next proof source', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES);
  const server = serveArtifact([{ base: 'https://h/a', fixture, hooks: { dropProof: true } }, { base: 'https://h/b', fixture }]);
  const stats = { verified: 0, rejected: 0 };
  const source = new ProofSource(['https://h/a.car', 'https://h/b.car'], { fetchFn: server.fetch, maxProofBytes: 1024 * 1024, stats });
  await source.root(parseCid(fixture.anchor, 'anchor'));
  assert.deepEqual(stats, { verified: 1, rejected: 0 });
});

test('raw sections are available as unverified leaf candidates', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES); const server = serveArtifact([{ base: 'https://h/a', fixture }]);
  const source = new ProofSource(['https://h/a.car'], { fetchFn: server.fetch, maxProofBytes: 1024 * 1024, stats: { verified: 0, rejected: 0 } });
  const root = await source.root(parseCid(fixture.anchor, 'anchor'));
  const entry = root.entries.get('/style.json')!;
  const digest = [...entry.src.digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(source.leafCandidate(digest), TREE_ENTRIES[0]!.bytes);
  source.discardLeafCandidate(digest);
  assert.equal(source.leafCandidate(digest), undefined);
});
