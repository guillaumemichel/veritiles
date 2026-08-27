// VerifiedAsset × routing hints (PLAN-hints S3): a raw anchor located whole via
// hints[anchor]; a bundle proof CAR located via hints[anchor] whose inline raw
// sections then serve small resources with no content host at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedAsset } from '../src/asset.ts';
import { buildArtifact, serveArtifact, type ServeEntry } from './helpers/artifact.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { buildRaw, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';
import { withPageUrl } from './helpers/serve-hints.ts';

const DOC = 'https://page.example/hints.json';

// A routed fetch over artifact hosts, hints documents, and whole-file URLs (a
// hinted src location serving one resource, path '').
function assetScene(entries: ServeEntry[], docs: Record<string, unknown>, whole: Record<string, Uint8Array> = {}) {
  const server = serveArtifact(entries);
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    (init as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted();
    requests.push(url);
    if (Object.prototype.hasOwnProperty.call(docs, url)) {
      return new Response(JSON.stringify({ hints: docs[url] }), { status: 200 });
    }
    if (Object.prototype.hasOwnProperty.call(whole, url)) {
      return new Response(new Uint8Array(whole[url]!), { status: 200 });
    }
    return server.fetch(url, init);
  }) as typeof fetch;
  return { fetchFn, requests };
}

test('HA-01: raw hints-only fails over the first dead URL to the second, then verifies', async () => {
  const fixture = await buildRaw();
  const DEAD = 'https://dead.example/raw';
  const LIVE = 'https://live.example/raw';
  const { fetchFn, requests } = assetScene([{ base: LIVE, fixture }], { [DOC]: { [fixture.anchor]: [DEAD, LIVE] } });
  const asset = new VerifiedAsset({ cid: fixture.anchor, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes(), fixture.files.get(''));
  assert.ok(requests.includes(DEAD) && requests.indexOf(DEAD) < requests.indexOf(LIVE), 'the dead URL was tried first');
  assert.equal(asset.stats.rejected, 0, 'a 404 is transport, not a rejection');
});

test('HA-02: raw configured-then-hinted — configured serves; a fresh client fails over to the hint', async () => {
  const fixture = await buildRaw();
  const A = 'https://a.example/raw';
  const B = 'https://b.example/raw';
  let downA = false;
  const { fetchFn, requests } = assetScene(
    [
      { base: A, fixture, hooks: { status: (url) => (downA && url === A ? 404 : undefined) } },
      { base: B, fixture },
    ],
    { [DOC]: { [fixture.anchor]: [B] } },
  );
  const configured = new VerifiedAsset({ cid: fixture.anchor, source: A, hints: DOC, fetchFn });
  assert.deepEqual(await configured.bytes(), fixture.files.get(''));
  assert.equal(requests.includes(B), false, 'configured base serves; the hint is untouched');

  downA = true;
  const failover = new VerifiedAsset({ cid: fixture.anchor, source: A, hints: DOC, fetchFn });
  assert.deepEqual(await failover.bytes(), fixture.files.get(''));
  assert.ok(requests.includes(B), 'a dead configured base fails over to the hint');
});

test('HA-03: hints-only bundle locates the proof CAR and serves a resource from its inline section', async () => {
  const fixture = await buildTree();
  const P = 'https://proof.example/bundle';
  const { fetchFn, requests } = assetScene([{ base: P, fixture }], { [DOC]: { [fixture.anchor]: [`${P}.car`] } });
  const asset = new VerifiedAsset({ cid: fixture.anchor, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.deepEqual(requests, [DOC, `${P}.car`], 'only the document and the CAR — no content host');
});

test('HA-04: a bundle with a configured source never touches the hints layer', async () => {
  const fixture = await buildTree();
  const BASE = 'https://cdn.example/bundle';
  const { fetchFn, requests } = assetScene([{ base: BASE, fixture }], { 'https://page.example/hints.json': { x: [] } });
  const asset = await withPageUrl('https://page.example/index.html', async () => new VerifiedAsset({ cid: fixture.anchor, source: BASE, fetchFn }));
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.equal(requests.some((u) => u.includes('hints.json')), false, 'zero hints requests');
});

test('HA-05: a bundle resource that 404s at {base}/{path} is served from a hinted src URL', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false }); // manifest-only CAR forces a content fetch
  const BASE = 'https://cdn.example/bundle';
  const SRC = 'https://mirror.example/style';
  const styleCid = fixture.srcCids!.get('style.json')!;
  const { fetchFn, requests } = assetScene(
    [{ base: BASE, fixture, hooks: { status: (url) => (url === `${BASE}/style.json` ? 404 : undefined) } }],
    { [DOC]: { [styleCid]: [SRC] } },
    { [SRC]: TREE_ENTRIES[0]!.bytes },
  );
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: BASE, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(requests.includes(`${BASE}/style.json`) && requests.includes(SRC), 'configured base tried first, then the hinted src URL');
  assert.equal(asset.stats.rejected, 0, 'a 404 at the base is transport, not a rejection');
});

test('HA-06: a hints-only bundle fetches resources per-src; a src with no entry errors naming the CID', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const P = 'https://proof.example/bundle';
  const SRC = 'https://s0.example/style';
  const styleCid = fixture.srcCids!.get('style.json')!;
  const zCid = fixture.srcCids!.get('fonts é/z.pbf')!;
  const { fetchFn } = assetScene(
    [{ base: P, fixture }],
    { [DOC]: { [fixture.anchor]: [`${P}.car`], [styleCid]: [SRC] } },
    { [SRC]: TREE_ENTRIES[0]!.bytes },
  );
  const asset = new VerifiedAsset({ cid: fixture.anchor, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  await assert.rejects(asset.bytes('fonts é/z.pbf'), (err: Error) => {
    assert.match(err.message, new RegExp(zCid));
    assert.match(err.message, /hints\.json/);
    return true;
  });
});

test("HA-08: a proof-CAR-only bundle probes the CAR's containing directory for a missing src", async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false }); // manifest-only: resources need content locations
  const CAR_BASE = 'https://node.example/pkgs/assets';
  const SRC = 'https://cdn.example/style';
  const styleCid = fixture.srcCids!.get('style.json')!;
  const { fetchFn, requests } = assetScene(
    [{ base: CAR_BASE, fixture }],
    { 'https://node.example/pkgs/hints.json': { [styleCid]: [SRC] } },
    { [SRC]: TREE_ENTRIES[0]!.bytes },
  );
  const asset = new VerifiedAsset({ cid: fixture.anchor, proof: `${CAR_BASE}.car`, fetchFn });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(requests.includes('https://node.example/pkgs/hints.json'), 'probed beside the CAR');
  assert.ok(requests.includes(SRC), 'resource served from the probed location');
});

test('HA-09: a query-string bundle source throws without proof or hints; explicit hints defer to open', async () => {
  const fixture = await buildTree();
  const Q = 'https://cdn.example/bundle?v=1';
  const P = 'https://proof.example/bundle';
  const { fetchFn, requests } = assetScene([{ base: P, fixture }], { [DOC]: { [fixture.anchor]: [`${P}.car`] } });
  assert.throws(() => new VerifiedAsset({ cid: fixture.anchor, source: Q, fetchFn }), /query string/);
  const deferred = new VerifiedAsset({ cid: fixture.anchor, source: Q, hints: DOC, fetchFn });
  assert.deepEqual(await deferred.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(requests.includes(`${P}.car`), 'the proof CAR came from hints[anchor]');
  assert.equal(requests.some((u) => u.startsWith(`${Q}.car`)), false, 'no CAR URL is derived from a query-string base');
});

test('HA-10: an explicit hinted proof CAR completes the derived one and serves failover', async () => {
  const fixture = await buildTree();
  const A = 'https://a.example/bundle';
  const MIRROR = 'https://mirror.example/bundle';
  const { fetchFn, requests } = assetScene(
    [
      { base: A, fixture, hooks: { status: (url) => (url === `${A}.car` ? 404 : undefined) } },
      { base: MIRROR, fixture },
    ],
    { [DOC]: { [fixture.anchor]: [`${MIRROR}.car`] } },
  );
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: A, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  const derived = requests.indexOf(`${A}.car`);
  const hinted = requests.indexOf(`${MIRROR}.car`);
  assert.ok(derived >= 0 && derived < hinted, `derived CAR tried first, hinted served: ${requests.join(', ')}`);
});

test("HA-13: a query-string bundle source probes its containing directory for the proof CAR; a miss stays retryable", async () => {
  const fixture = await buildTree();
  const Q = 'https://node.example/pkgs/assets?tok=1';
  const CAR_BASE = 'https://node.example/pkgs/assets';
  const PROBE = 'https://node.example/pkgs/hints.json';
  const docs: Record<string, unknown> = { [DOC]: {} }; // explicit doc has no anchor entry
  const { fetchFn, requests } = assetScene([{ base: CAR_BASE, fixture }], docs);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: Q, hints: DOC, fetchFn });
  await assert.rejects(asset.bytes('style.json'), (err: Error) => {
    assert.match(err.message, new RegExp(fixture.anchor));
    assert.match(err.message, /pkgs\/hints\.json/);
    return true;
  });
  assert.equal(asset.stats.rejected, 0, 'a probe miss is transport, never a rejection');
  docs[PROBE] = { [fixture.anchor]: [`${CAR_BASE}.car`] };
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(requests.indexOf(DOC) < requests.indexOf(PROBE), 'explicit doc consulted before the probe');
});

test('HA-11: a raw {cid} alone consults the default ./hints.json beside the page', async () => {
  const fixture = await buildRaw();
  const LIVE = 'https://live.example/raw';
  const { fetchFn, requests } = assetScene([{ base: LIVE, fixture }], {
    'https://page.example/hints.json': { [fixture.anchor]: [LIVE] },
  });
  const asset = await withPageUrl('https://page.example/index.html', async () => new VerifiedAsset({ cid: fixture.anchor, fetchFn }));
  assert.deepEqual(await asset.bytes(), fixture.files.get(''));
  assert.ok(requests.includes('https://page.example/hints.json'), 'the defaulted document was consulted');
});

test('HA-12: a bundle {cid} alone locates its proof CAR via the default ./hints.json', async () => {
  const fixture = await buildTree();
  const P = 'https://node.example/bundle';
  const { fetchFn, requests } = assetScene([{ base: P, fixture }], {
    'https://page.example/hints.json': { [fixture.anchor]: [`${P}.car`] },
  });
  const asset = await withPageUrl('https://page.example/index.html', async () => new VerifiedAsset({ cid: fixture.anchor, fetchFn }));
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(requests.includes('https://page.example/hints.json'), 'the defaulted document was consulted');
});

test('HA-07: a lying hinted src host is banned once and never retried for a later resource', async () => {
  const bytesA = deterministicBytes(500, 77);
  const bytesB = deterministicBytes(400, 78);
  const fixture = await buildArtifact([{ path: 'a.bin', bytes: bytesA }, { path: 'b.bin', bytes: bytesB }], { inlineRaw: false });
  const P = 'https://proof.example/bundle';
  const LIAR = 'https://liar.example/f';
  const HONEST_A = 'https://honest-a.example/f';
  const HONEST_B = 'https://honest-b.example/f';
  const srcA = fixture.srcCids!.get('a.bin')!;
  const srcB = fixture.srcCids!.get('b.bin')!;
  const { fetchFn, requests } = assetScene(
    [{ base: P, fixture }],
    { [DOC]: { [fixture.anchor]: [`${P}.car`], [srcA]: [LIAR, HONEST_A], [srcB]: [LIAR, HONEST_B] } },
    { [LIAR]: flipByte(bytesA), [HONEST_A]: bytesA, [HONEST_B]: bytesB },
  );
  const asset = new VerifiedAsset({ cid: fixture.anchor, hints: DOC, fetchFn });
  assert.deepEqual(await asset.bytes('a.bin'), bytesA);
  assert.ok(asset.stats.rejected >= 1, 'the lying host was caught');
  requests.length = 0;
  assert.deepEqual(await asset.bytes('b.bin'), bytesB);
  assert.equal(requests.includes(LIAR), false, 'the banned host is not retried for a different resource');
});
