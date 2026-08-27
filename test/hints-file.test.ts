// VerifiedFile × routing hints (PLAN-hints S2): hints-only open, configured +
// hinted failover, hinted-host tamper bans, and the request-accounting
// invariants — most sharply, that a fully configured client never touches the
// hints layer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from '../src/verified-file.ts';
import { flipByte } from './helpers/bytes.ts';
import { buildPkgFlat } from './helpers/pkg-fixtures.ts';
import { scene, withPageUrl } from './helpers/serve-hints.ts';

const DOC = 'https://page.example/hints.json';

test('HF-01: hinted constructions succeed and preserve existing throws', async () => {
  const pkg = await buildPkgFlat();
  assert.doesNotThrow(() => new VerifiedFile({ cid: pkg.anchor }));
  assert.doesNotThrow(() => new VerifiedFile({ cid: pkg.anchor, proof: 'https://h/p' }));
  assert.doesNotThrow(() => new VerifiedFile({ cid: pkg.anchor, hints: DOC }));
  assert.doesNotThrow(() => new VerifiedFile({ cid: pkg.anchor, source: 'https://h/f?v=1', hints: DOC }));
  assert.throws(() => new VerifiedFile({ cid: pkg.anchor, source: 'https://h/f?v=1' }), Error);
  assert.throws(() => new VerifiedFile({ cid: pkg.anchor, source: [] }), Error);
});

test('HF-02: hints-only open resolves doc → root → content, and a read verifies', async () => {
  const pkg = await buildPkgFlat();
  const H = 'https://node.example/map';
  const { fetchFn, requests } = scene([{ fileUrl: H, bytes: pkg.mapBytes, proofs: pkg.proofs }], {
    [DOC]: { [pkg.anchor]: [`${H}.proofs`], [pkg.mapCid]: [H] },
  });
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
  const docIdx = requests.indexOf(DOC);
  const rootIdx = requests.indexOf(`${H}.proofs/root`);
  const contentIdx = requests.indexOf(H);
  assert.ok(docIdx >= 0 && docIdx < rootIdx && rootIdx < contentIdx, `order: ${requests.join(', ')}`);
  assert.equal(requests.filter((u) => u === DOC).length, 1, 'the document is fetched once');
});

test('HF-03: configured content is hit first; a transport 404 fails over to the hinted host', async () => {
  const pkg = await buildPkgFlat();
  const A = 'https://a.example/map';
  const B = 'https://b.example/map';
  let downA = false;
  const { fetchFn, requests } = scene(
    [
      { fileUrl: A, bytes: pkg.mapBytes, proofs: pkg.proofs, hooks: { fileStatus: () => (downA ? 404 : undefined) } },
      { fileUrl: B, bytes: pkg.mapBytes },
    ],
    { [DOC]: { [pkg.mapCid]: [B] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, source: A, hints: DOC, fetchFn });
  const first = pkg.leaves[0]!;
  await vf.read(first.offset, first.length);
  assert.equal(requests.includes(B), false, 'configured host serves; hinted host untouched');

  downA = true;
  const next = pkg.leaves[1]!;
  assert.deepEqual(await vf.read(next.offset, next.length), pkg.mapBytes.subarray(next.offset, next.offset + next.length));
  assert.ok(requests.includes(B), 'failed over to the hinted host');
  assert.equal(vf.stats.rejected, 0, 'a transport 404 is not a rejection');
});

test('HF-04: a hinted proof URL with a query string is ignored; the hinted map URL is used', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://proof.example/map';
  const C = 'https://content.example/map';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs },
      { fileUrl: C, bytes: pkg.mapBytes },
    ],
    { [DOC]: { [pkg.anchor]: ['https://q.example/base?v=1', `${P}.proofs`], [pkg.mapCid]: [C] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
  assert.equal(requests.some((u) => u.includes('q.example')), false, 'the query-string proof base is never formed');
  assert.ok(requests.includes(C), 'the hinted map URL served content');
});

test('HF-05: a tampering hinted content host is counted, banned, and survived via the next hint', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://proof.example/map';
  const EVIL = 'https://evil.example/map';
  const GOOD = 'https://good.example/map';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs },
      { fileUrl: EVIL, bytes: pkg.mapBytes, hooks: { tamperRange: (b) => flipByte(b) } },
      { fileUrl: GOOD, bytes: pkg.mapBytes },
    ],
    { [DOC]: { [pkg.anchor]: [`${P}.proofs`], [pkg.mapCid]: [EVIL, GOOD] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  const first = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(first.offset, first.length), pkg.mapBytes.subarray(first.offset, first.offset + first.length));
  assert.ok(vf.stats.rejected >= 1, 'the lying hinted host was caught');
  requests.length = 0;
  const next = pkg.leaves[1]!;
  await vf.read(next.offset, next.length);
  assert.equal(requests.includes(EVIL), false, 'the banned hinted host is never retried');
});

test('HF-06: no proof location anywhere errors naming the anchor and consulted docs; fixing the doc heals', async () => {
  const pkg = await buildPkgFlat();
  const H = 'https://node.example/map';
  const docs: Record<string, unknown> = {}; // DOC absent → 404
  const { fetchFn } = scene([{ fileUrl: H, bytes: pkg.mapBytes, proofs: pkg.proofs }], docs);
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  await assert.rejects(vf.read(0, 100), (err: Error) => {
    assert.equal(err instanceof Error && err.name, 'Error', 'a plain transport-level error');
    assert.match(err.message, new RegExp(pkg.anchor));
    assert.match(err.message, /hints\.json/);
    return true;
  });
  assert.equal(vf.stats.rejected, 0, 'a hints miss never counts as a rejection');
  docs[DOC] = { [pkg.anchor]: [`${H}.proofs`], [pkg.mapCid]: [H] };
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
});

test('HF-07: hints-only makes no content-host request before the root response', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://proof.example/map';
  const C = 'https://content.example/map';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs },
      { fileUrl: C, bytes: pkg.mapBytes },
    ],
    { [DOC]: { [pkg.anchor]: [`${P}.proofs`], [pkg.mapCid]: [C] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  const leaf = pkg.leaves[0]!;
  await vf.read(leaf.offset, leaf.length);
  const rootIdx = requests.indexOf(`${P}.proofs/root`);
  assert.ok(rootIdx >= 0);
  assert.equal(requests.slice(0, rootIdx).some((u) => u === C), false, 'no content request before root');
});

test('HF-08: the stats object identity is stable from construction through reads', async () => {
  const pkg = await buildPkgFlat();
  const H = 'https://node.example/map';
  const { fetchFn } = scene([{ fileUrl: H, bytes: pkg.mapBytes, proofs: pkg.proofs }], {
    [DOC]: { [pkg.anchor]: [`${H}.proofs`], [pkg.mapCid]: [H] },
  });
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: DOC, fetchFn });
  const before = vf.stats;
  const leaf = pkg.leaves[0]!;
  await vf.read(leaf.offset, leaf.length);
  assert.equal(vf.stats, before, 'same object reference');
  assert.ok(vf.stats.verified > 0);
});

test('HF-10: an explicit hinted proof base completes the derived one and serves failover', async () => {
  const pkg = await buildPkgFlat();
  const A = 'https://a.example/map';
  const MIRROR = 'https://mirror.example/map';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: A, bytes: pkg.mapBytes, proofs: pkg.proofs, hooks: { proofStatus: () => 404 } },
      { fileUrl: MIRROR, bytes: pkg.mapBytes, proofs: pkg.proofs },
    ],
    { [DOC]: { [pkg.anchor]: [`${MIRROR}.proofs`] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, source: A, hints: DOC, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
  const derived = requests.indexOf(`${A}.proofs/root`);
  const hinted = requests.indexOf(`${MIRROR}.proofs/root`);
  assert.ok(derived >= 0 && derived < hinted, `derived proof base tried first, hinted served: ${requests.join(', ')}`);
  assert.ok(requests.includes(A), 'content still comes from the configured source');
});

test('HF-09: a fully configured client never touches the hints layer', async () => {
  const pkg = await buildPkgFlat();
  const H = 'https://node.example/map';
  const { fetchFn, requests } = scene(
    [{ fileUrl: H, bytes: pkg.mapBytes, proofs: pkg.proofs }],
    { 'https://page.example/hints.json': { [pkg.mapCid]: [H] } },
  );
  const vf = await withPageUrl('https://page.example/index.html', async () => new VerifiedFile({ cid: pkg.anchor, source: H, fetchFn }));
  const leaf = pkg.leaves[0]!;
  await vf.read(leaf.offset, leaf.length);
  assert.equal(requests.some((u) => u.includes('hints.json')), false, 'zero hints requests, ever');
});
