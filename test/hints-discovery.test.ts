// Discovery probes (PLAN-hints S5): a directory a client already knows may
// carry `{u}/hints.json`, so a proof-only node advertises where content lives
// (SPEC §5). Probes fire only when a class is missing, never on the
// happy path, and every chain is bounded by the per-client document cap.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from '../src/verified-file.ts';
import { MAX_HINT_DOCS } from '../src/limits.ts';
import { buildPkgFlat } from './helpers/pkg-fixtures.ts';
import { scene, withPageUrl } from './helpers/serve-hints.ts';

const slice = (b: Uint8Array, o: number, n: number) => b.subarray(o, o + n);

test('HD-01: {cid, proof} probes the proof directory once for content, then reads', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://node.example/map';
  const C = 'https://cdn.example/map';
  const { fetchFn, requests } = scene(
    [{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: C, bytes: pkg.mapBytes }],
    { [`${P}.proofs/hints.json`]: { [pkg.mapCid]: [C] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
  assert.equal(requests.filter((u) => u === `${P}.proofs/hints.json`).length, 1, 'probed exactly once');
  const root = requests.indexOf(`${P}.proofs/root`);
  const probe = requests.indexOf(`${P}.proofs/hints.json`);
  const content = requests.indexOf(C);
  assert.ok(root < probe && probe < content, `probe after the proof descent, before content: ${requests.join(', ')}`);
});

test('HD-02: a probe 404 fails the open naming the anchor and consulted docs, and stays retryable', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://node.example/map';
  const C = 'https://cdn.example/map';
  const docs: Record<string, unknown> = {}; // no in-directory doc yet
  const { fetchFn } = scene(
    [{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: C, bytes: pkg.mapBytes }],
    docs,
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn });
  // The unlocated class is content, so the error names the needed CID: the map.
  await assert.rejects(vf.read(0, 100), (err: Error) => {
    assert.match(err.message, new RegExp(pkg.mapCid));
    assert.match(err.message, new RegExp(`${P}.proofs/hints.json`.replace(/[.]/g, '\\.')));
    return true;
  });
  assert.equal(vf.stats.rejected, 0);
  docs[`${P}.proofs/hints.json`] = { [pkg.mapCid]: [C] };
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
});

test('HD-03: a page doc names a proof dir whose own hints.json names content (location → doc → location)', async () => {
  const pkg = await buildPkgFlat();
  const PAGE = 'https://page.example/hints.json';
  const P = 'https://node.example/map';
  const C = 'https://cdn.example/map';
  const { fetchFn } = scene(
    [{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: C, bytes: pkg.mapBytes }],
    { [PAGE]: { [pkg.anchor]: [`${P}.proofs`] }, [`${P}.proofs/hints.json`]: { [pkg.mapCid]: [C] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: PAGE, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
});

test('HD-04: an adversarial directory chain terminates at the document cap with a clean error', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://d0.example/map';
  const dirs = Array.from({ length: 22 }, (_, i) => `https://d${i}.example/map.proofs`);
  const docs: Record<string, unknown> = {};
  for (let i = 0; i < dirs.length - 1; i++) docs[`${dirs[i]}/hints.json`] = { [pkg.anchor]: [dirs[i + 1]] };
  const { fetchFn, requests } = scene([{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }], docs);
  const vf = new VerifiedFile({ cid: pkg.anchor, proof: dirs[0], fetchFn });
  await assert.rejects(vf.read(0, 100), (err: Error) => {
    assert.match(err.message, new RegExp(pkg.mapCid));
    return true;
  });
  assert.equal(requests.filter((u) => u.endsWith('hints.json')).length, MAX_HINT_DOCS, 'no more than the document cap is fetched');
  assert.equal(vf.stats.rejected, 0);
});

test('HD-05: a fully configured client issues zero probe requests', async () => {
  const pkg = await buildPkgFlat();
  const H = 'https://node.example/map';
  const { fetchFn, requests } = scene(
    [{ fileUrl: H, bytes: pkg.mapBytes, proofs: pkg.proofs }],
    { [`${H}.proofs/hints.json`]: { [pkg.mapCid]: ['https://elsewhere.example/map'] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, source: H, fetchFn });
  const leaf = pkg.leaves[0]!;
  await vf.read(leaf.offset, leaf.length);
  assert.equal(requests.some((u) => u.endsWith('hints.json')), false, 'no probe, ever');
});

test("HD-07: proof unlocated with a query-string source probes the source's containing directory", async () => {
  const pkg = await buildPkgFlat();
  const FILE = 'https://data.example/maps/world.pmtiles?tok=1';
  const PROOFS = 'https://data.example/maps/world.pmtiles.proofs';
  const PAGE = 'https://page.example/hints.json';
  const { fetchFn, requests } = scene(
    [{ fileUrl: FILE, bytes: pkg.mapBytes, proofs: pkg.proofs, proofBase: PROOFS }],
    { [PAGE]: {}, 'https://data.example/maps/hints.json': { [pkg.anchor]: [PROOFS] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, hints: PAGE, fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
  const page = requests.indexOf(PAGE);
  const probe = requests.indexOf('https://data.example/maps/hints.json');
  assert.ok(page >= 0 && page < probe, `explicit doc consulted before the probe: ${requests.join(', ')}`);
  assert.equal(requests.filter((u) => u === 'https://data.example/maps/hints.json').length, 1, 'probed once');
});

test('HD-06: the default ./hints.json resolves end to end against an injected base', async () => {
  const pkg = await buildPkgFlat();
  const P = 'https://site.example/app/map';
  const C = 'https://site.example/app/cdn';
  const { fetchFn, requests } = scene(
    [{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: C, bytes: pkg.mapBytes }],
    { 'https://site.example/app/hints.json': { [pkg.anchor]: [`${P}.proofs`], [pkg.mapCid]: [C] } },
  );
  const vf = await withPageUrl('https://site.example/app/index.html', async () => new VerifiedFile({ cid: pkg.anchor, fetchFn }));
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
  assert.ok(requests.includes('https://site.example/app/hints.json'), 'the default document was consulted');
});
