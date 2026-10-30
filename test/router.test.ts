// Routers (SPEC §6): every location comes from a router. A custom one
// replaces the built-in router, gets the page's own locations as `defaults`,
// and yields the URLs of a CID's bytes — a ranged file's anchor at
// `{proof}/root`, a bundle's anchor at its manifest block or CAR — read
// lazily, one location at a time. It may carry every request and hear what
// became of it. Every routed byte verifies like a configured one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PMTiles } from 'pmtiles';

import { VerifiedAsset } from '../packages/veritiles/src/asset.ts';
import { hints } from '../packages/anymirror/src/hints.ts';
import type { FetchContext, Router } from '../packages/router/src/index.ts';
import { send, toRouter } from '../packages/anymirror/src/routing.ts';
import { VerifiedSource } from '../packages/veritiles/src/source.ts';
import { VerifiedFile } from '../packages/anymirror/src/verified-file.ts';
import { packPmtiles } from '../tools/pack.ts';
import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { buildRaw, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';
import { buildPkgFlat } from './helpers/pkg-fixtures.ts';
import { writePmtilesArchive } from './helpers/pmtiles-writer.ts';
import { scene, withPageUrl } from './helpers/serve-hints.ts';

// A router over a fixed table, logging every CID it is asked about. With
// `fallback`, the page's own locations come first and the table's only once
// those run out (`lookups` logs the CIDs that got that far); `down` makes it
// throw.
function tableRouter(table: Record<string, string[]>, { fallback = false } = {}) {
  const calls: string[] = [];
  const lookups: string[] = [];
  const state = { down: false };
  const router: Router = {
    async *locate(cid, { defaults }) {
      calls.push(cid);
      if (fallback) yield* defaults;
      lookups.push(cid);
      if (state.down) throw new Error('router down');
      yield* table[cid] ?? [];
    },
  };
  return { router, calls, lookups, state };
}

// An artifact host that also serves hints documents at their URLs.
function withDocs(server: { fetch: typeof fetch; requests: string[] }, docs: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!Object.hasOwn(docs, url)) return server.fetch(url, init);
    server.requests.push(url);
    return new Response(JSON.stringify({ hints: docs[url] }));
  }) as typeof fetch;
}

test('RT-02: a read gives up after 16 failed locations, skipped values taking no slot; the next read reads on', async () => {
  const pkg = await buildPkgFlat();
  const HOST = 'https://host.example/world.pmtiles';
  const host = { fileUrl: HOST, bytes: pkg.mapBytes, proofs: pkg.proofs };
  const unusable = Array.from({ length: 20 }, (_, i) => `https://dir${i}.example/world.pmtiles.proofs`);
  const skipped = tableRouter({ [pkg.anchor]: [...unusable, `${HOST}.proofs/root`], [pkg.mapCid]: [HOST] });
  const opened = new VerifiedFile({ cid: pkg.anchor, router: skipped.router, fetchFn: scene([host], {}).fetchFn });
  assert.deepEqual(await opened.read(0, 100), pkg.mapBytes.subarray(0, 100), 'skipped values take no slot');

  const dead = Array.from({ length: 16 }, (_, i) => `https://dead${i}.example/world.pmtiles.proofs/root`);
  const capped = tableRouter({ [pkg.anchor]: [...dead, `${HOST}.proofs/root`], [pkg.mapCid]: [HOST] });
  const { fetchFn, requests } = scene([host], {});
  const vf = new VerifiedFile({ cid: pkg.anchor, router: capped.router, fetchFn });
  const deadRoots = () => requests.filter((u) => u.startsWith('https://dead') && u.endsWith('/root')).length;
  await assert.rejects(vf.read(0, 100), AggregateError);
  assert.equal(deadRoots(), 16);
  assert.equal(requests.includes(`${HOST}.proofs/root`), false, 'the 17th location waits for the next read');
  assert.deepEqual(await vf.read(0, 100), pkg.mapBytes.subarray(0, 100));
  assert.equal(deadRoots(), 16, 'the failed ones wait behind it');
  assert.deepEqual(capped.calls, [pkg.anchor, pkg.mapCid], 'read on, not asked again');
});

test('RT-04: a router must be a function or an object with a locate method', () => {
  const anchor = 'bafyreiazjnja3qydqsz7yiz6ci3xra26flodmlmry3rtafpnhwzdphl6ue';
  const router = 'https://router.example' as unknown as Router;
  assert.throws(() => new VerifiedFile({ cid: anchor, router }), /router must be a function or an object with a locate method/);
  assert.throws(() => new VerifiedAsset({ cid: anchor, router }), /router must be a function or an object with a locate method/);
});

test('RT-05: a router is a function, or an object with locate and maybe fetch', () => {
  const locate = () => [];
  assert.equal(toRouter(undefined), undefined);
  assert.equal(toRouter(locate)!.locate, locate);
  const object = { locate, fetch: async () => new Response() };
  assert.equal(toRouter(object), object);
  for (const bad of ['https://router.example', { fetch: async () => new Response() }, { locate, fetch: 'x' }, null, 42]) {
    assert.throws(() => toRouter(bad), /router must be a function or an object with a locate method/);
  }
});

test("RT-06: a request goes out synchronously — through the router's fetch with a fresh context, else the client's fetch", async () => {
  const sent: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response('ok');
  }) as typeof fetch;
  const plain = send(undefined, fetchFn, 'https://a.example/x', {});
  assert.deepEqual(sent, ['https://a.example/x']);
  plain.settle('verified');
  assert.equal(await (await plain.response).text(), 'ok');

  const contexts: FetchContext[] = [];
  const router: Router = { locate: () => [], fetch: (url, init, context) => (contexts.push(context), context.next(url, init)) };
  const route = { router, cid: 'bafkfile', location: 'https://b.example/x' };
  const first = send(route, fetchFn, 'https://b.example/x', {});
  const second = send(route, fetchFn, 'https://b.example/x', {});
  assert.equal(contexts.length, 2, 'the router sees each request at once');
  assert.deepEqual(sent.slice(1), ['https://b.example/x', 'https://b.example/x'], 'context.next is the client fetch');
  first.settle('rejected');
  second.settle('unused');
  assert.deepEqual(await Promise.all(contexts.map((c) => c.verdict)), ['rejected', 'unused']);
  assert.equal(toRouter(() => [])!.fetch, undefined, 'a bare locate carries no requests');
});

test('RF-01: anchor-only file — the router locates `{proof}/root`, then the map once the descriptor names it', async () => {
  const pkg = await buildPkgFlat();
  const HOST = 'https://host.example/world.pmtiles';
  const { fetchFn, requests } = scene([{ fileUrl: HOST, bytes: pkg.mapBytes, proofs: pkg.proofs }], {});
  const { router, calls } = tableRouter({ [pkg.anchor]: [`${HOST}.proofs/root`], [pkg.mapCid]: [HOST] });
  const vf = new VerifiedFile({ cid: pkg.anchor, router, fetchFn });
  assert.deepEqual(await vf.read(0, pkg.mapBytes.length), pkg.mapBytes);
  assert.deepEqual(calls, [pkg.anchor, pkg.mapCid], 'the anchor first; the map only after the descriptor verified');
  assert.equal(requests[0], `${HOST}.proofs/root`);
  assert.deepEqual(vf.stats.rejected, 0);
});

test('RF-02: a routed URL that is not `{proof}/root` cannot root the proof tree and is skipped', async () => {
  const pkg = await buildPkgFlat();
  const HOST = 'https://host.example/world.pmtiles';
  const { fetchFn, requests } = scene([{ fileUrl: HOST, bytes: pkg.mapBytes, proofs: pkg.proofs }], {});
  const { router } = tableRouter({
    [pkg.anchor]: [`${HOST}.proofs`, `${HOST}.proofs/root?sig=1`, `${HOST}.proofs/notroot`],
    [pkg.mapCid]: [HOST],
  });
  const vf = new VerifiedFile({ cid: pkg.anchor, router, fetchFn });
  await assert.rejects(vf.read(0, 10), /no proof location for .*; consulted the router/);
  assert.deepEqual(requests, [], 'nothing fetched from an unusable location');
});

test("RF-03: a fallback router serves the page's own locations first, and looks up a CID only once they run out", async () => {
  const pkg = await buildPkgFlat();
  const OWN = 'https://own.example/world.pmtiles';
  const MIRROR = 'https://mirror.example/world.pmtiles';
  let ownDown = false;
  const { fetchFn, requests } = scene(
    [
      { fileUrl: OWN, bytes: pkg.mapBytes, proofs: pkg.proofs, hooks: { fileStatus: () => (ownDown ? 503 : undefined) } },
      { fileUrl: MIRROR, bytes: pkg.mapBytes, proofs: pkg.proofs },
    ],
    {},
  );
  const { router, calls, lookups } = tableRouter({ [pkg.anchor]: [`${MIRROR}.proofs/root`], [pkg.mapCid]: [MIRROR] }, { fallback: true });
  const vf = new VerifiedFile({ cid: pkg.anchor, source: OWN, router, fetchFn });
  assert.deepEqual(await vf.read(0, 1000), pkg.mapBytes.subarray(0, 1000));
  assert.deepEqual(calls, [pkg.anchor, pkg.mapCid]);
  assert.deepEqual(lookups, [], "the page's own hosts served: no lookup");
  ownDown = true;
  const at = 7 * 262144;
  assert.deepEqual(await vf.read(at, 1000), pkg.mapBytes.subarray(at, at + 1000));
  assert.deepEqual(lookups, [pkg.mapCid], 'the own file host failed: the lookup ran for the map alone');
  assert.ok(requests.includes(MIRROR));
});

test('RF-04: a tampering routed host is banned, and a router carrying the requests hears it rejected', async () => {
  const pkg = await buildPkgFlat();
  const BAD = 'https://bad.example/world.pmtiles';
  const GOOD = 'https://good.example/world.pmtiles';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: BAD, bytes: pkg.mapBytes, proofs: pkg.proofs, hooks: { tamperRange: (b) => flipByte(b) } },
      { fileUrl: GOOD, bytes: pkg.mapBytes, proofs: pkg.proofs },
    ],
    {},
  );
  const table = tableRouter({ [pkg.anchor]: [`${BAD}.proofs/root`], [pkg.mapCid]: [BAD, GOOD] });
  const heard: Promise<string>[] = [];
  const router: Router = {
    locate: table.router.locate,
    fetch: (url, init, context) => {
      if (context.cid === pkg.mapCid) heard.push(context.verdict.then((verdict) => `${new URL(url).host} ${verdict}`));
      return context.next(url, init);
    },
  };
  const vf = new VerifiedFile({ cid: pkg.anchor, router, fetchFn });
  assert.deepEqual(await vf.read(0, 1000), pkg.mapBytes.subarray(0, 1000));
  assert.ok(vf.stats.rejected >= 1, 'the tampered response was caught and discarded');
  assert.ok((await Promise.all(heard)).includes('bad.example rejected'));
  requests.length = 0;
  const at = 7 * 262144;
  assert.deepEqual(await vf.read(at, 1000), pkg.mapBytes.subarray(at, at + 1000));
  assert.equal(requests.includes(BAD), false, 'the tampering host is banned for the session');
  assert.ok(requests.includes(GOOD));
});

test('RF-05: a router that fails is asked again on the next read; it lifts no query-string rule', async () => {
  const pkg = await buildPkgFlat();
  const HOST = 'https://host.example/world.pmtiles';
  const { fetchFn } = scene([{ fileUrl: HOST, bytes: pkg.mapBytes, proofs: pkg.proofs }], {});
  const { router, calls, state } = tableRouter({ [pkg.anchor]: [`${HOST}.proofs/root`], [pkg.mapCid]: [HOST] });
  const vf = new VerifiedFile({ cid: pkg.anchor, router, fetchFn });
  state.down = true;
  await assert.rejects(vf.read(0, 100), /no proof location for .*; consulted the router/);
  state.down = false;
  assert.deepEqual(await vf.read(0, 100), pkg.mapBytes.subarray(0, 100));
  assert.deepEqual(calls, [pkg.anchor, pkg.anchor, pkg.mapCid]);
  assert.throws(() => new VerifiedFile({ cid: pkg.anchor, source: `${HOST}?sig=abc`, router, fetchFn }), /explicit proof URL is required/);
});

test('RF-06: the real pmtiles reader over a router-only page', async () => {
  const archive = writePmtilesArchive([
    { z: 0, x: 0, y: 0, data: deterministicBytes(500, 1) },
    { z: 1, x: 1, y: 0, data: deterministicBytes(2048, 3) },
  ]);
  const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 0 });
  const HOST = 'https://host.example/world.pmtiles';
  const { fetchFn } = scene([{ fileUrl: HOST, bytes: archive.bytes, proofs: packed.proofs }], {});
  const { router } = tableRouter({ [packed.anchor]: [`${HOST}.proofs/root`], [packed.mapCid]: [HOST] });
  const pm = new PMTiles(new VerifiedSource({ cid: packed.anchor, router, fetchFn }));
  assert.equal((await pm.getHeader()).maxZoom, 1);
  assert.deepEqual(new Uint8Array((await pm.getZxy(1, 1, 0))!.data), deterministicBytes(2048, 3));
});

test('RF-07: with hints on, the default hints document is among the defaults: consulted only by a router that reads them', async () => {
  const pkg = await buildPkgFlat();
  const HOST = 'https://host.example/world.pmtiles';
  const { fetchFn, requests } = scene([{ fileUrl: HOST, bytes: pkg.mapBytes, proofs: pkg.proofs }], {});
  const table = { [pkg.anchor]: [`${HOST}.proofs/root`], [pkg.mapCid]: [HOST] };
  await withPageUrl('https://app.example/map.html', async () => {
    const own = new VerifiedFile({ cid: pkg.anchor, router: tableRouter(table).router, fetchFn, hints: hints() });
    assert.deepEqual(await own.read(0, 100), pkg.mapBytes.subarray(0, 100));
    assert.equal(requests.includes('https://app.example/hints.json'), false, 'its defaults unread');
    const fallback = new VerifiedFile({ cid: pkg.anchor, router: tableRouter(table, { fallback: true }).router, fetchFn, hints: hints() });
    assert.deepEqual(await fallback.read(0, 100), pkg.mapBytes.subarray(0, 100));
    assert.ok(requests.includes('https://app.example/hints.json'), 'read through its defaults');
  });
});

test('RA-01: a raw asset located by the router alone', async () => {
  const fixture = await buildRaw();
  const URL = 'https://host.example/raw';
  const server = serveArtifact([{ base: URL, fixture }]);
  const { router, calls } = tableRouter({ [fixture.anchor]: [URL] });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes(), fixture.files.get(''));
  assert.deepEqual(calls, [fixture.anchor]);
});

test('RA-02: a bundle by its bare manifest block, each resource by its src', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const BASE = 'https://host.example/bundle';
  const server = serveArtifact([{ base: BASE, fixture }]);
  const style = fixture.srcCids!.get('style.json')!;
  const { router, calls } = tableRouter({ [fixture.anchor]: [`${BASE}.masl`], [style]: [`${BASE}/style.json`] });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.deepEqual(calls, [fixture.anchor, style]);
  assert.deepEqual(server.requests, [`${BASE}.masl`, `${BASE}/style.json`]);
  assert.deepEqual(asset.stats, { verified: 2, rejected: 0 }, 'the manifest block and the file');
});

test('RA-03: a bundle anchor routed to a CAR still works, inline sections included', async () => {
  const fixture = await buildTree();
  const BASE = 'https://host.example/bundle';
  const server = serveArtifact([{ base: BASE, fixture }]);
  const { router } = tableRouter({ [fixture.anchor]: [`${BASE}.car`] });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.deepEqual(server.requests, [`${BASE}.car`], 'served from the CAR: no content request');
});

test('RA-04: a routed block that is neither the anchor nor a CAR is a proof fault; the next location serves', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const BAD = 'https://bad.example/bundle';
  const GOOD = 'https://good.example/bundle';
  const server = serveArtifact([
    { base: BAD, fixture, hooks: { tamper: (url, bytes) => (url.endsWith('.masl') ? flipByte(bytes) : undefined) } },
    { base: GOOD, fixture },
  ]);
  const style = fixture.srcCids!.get('style.json')!;
  const { router } = tableRouter({ [fixture.anchor]: [`${BAD}.masl`, `${GOOD}.masl`], [style]: [`${GOOD}/style.json`] });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.equal(asset.stats.rejected, 1);
});

test('RA-05: a cached bundle resource needs no location, so no router call', async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const BASE = 'https://host.example/bundle';
  const style = fixture.srcCids!.get('style.json')!;
  const { router, calls, state } = tableRouter({ [fixture.anchor]: [`${BASE}.masl`], [style]: [`${BASE}/style.json`] });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: serveArtifact([{ base: BASE, fixture }]).fetch });
  await asset.bytes('style.json');
  state.down = true;
  assert.deepEqual(await asset.bytes('style.json'), TREE_ENTRIES[0]!.bytes, 'served from the verified cache');
  assert.deepEqual(calls, [fixture.anchor, style]);
});

test("RA-06: a bundle's requests name their CID and location: the manifest block for the anchor, a file for its src", async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const BASE = 'https://host.example/bundle';
  const style = fixture.srcCids!.get('style.json')!;
  const table = tableRouter({ [fixture.anchor]: [`${BASE}.masl`], [style]: [`${BASE}/style.json`] });
  const heard: Promise<string>[] = [];
  const router: Router = {
    locate: table.router.locate,
    fetch: (url, init, context) => {
      const cid = context.cid === fixture.anchor ? 'anchor' : context.cid === style ? 'style' : context.cid;
      heard.push(context.verdict.then((verdict) => `${url} ${cid} ${context.location} ${verdict}`));
      return context.next(url, init);
    },
  };
  const asset = new VerifiedAsset({ cid: fixture.anchor, router, fetchFn: serveArtifact([{ base: BASE, fixture }]).fetch });
  await asset.bytes('style.json');
  assert.deepEqual(await Promise.all(heard), [
    `${BASE}.masl anchor ${BASE}.masl verified`,
    `${BASE}/style.json style ${BASE}/style.json verified`,
  ]);
});

test("RA-07: the built-in router probes beside the page's own locations, never beside a custom router's", async () => {
  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const BASE = 'https://host.example/b/bundle';
  const DOC = 'https://host.example/b/hints.json';
  const style = fixture.srcCids!.get('style.json')!;
  const server = serveArtifact([{ base: BASE, fixture }]);
  const fetchFn = withDocs(server, { [DOC]: { [style]: [`${BASE}/style.json`] } });
  const routed = tableRouter({ [fixture.anchor]: [`${BASE}.masl`] }, { fallback: true });
  await assert.rejects(new VerifiedAsset({ cid: fixture.anchor, router: routed.router, fetchFn }).bytes('style.json'), /no content location for/);
  assert.equal(server.requests.includes(DOC), false, 'nothing probed beside the routed block');
  const own = new VerifiedAsset({ cid: fixture.anchor, proof: `${BASE}.masl`, router: tableRouter({}, { fallback: true }).router, fetchFn });
  assert.deepEqual(await own.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
  assert.ok(server.requests.includes(DOC), 'probed beside the configured one');
});

test('RT-07: a read stops waiting when its caller aborts, though the router never answers', async () => {
  const stalled: Router = { locate: () => new Promise<string[]>(() => {}) };
  const pkg = await buildPkgFlat();
  const file = new VerifiedFile({ cid: pkg.anchor, router: stalled });
  const reading = new AbortController();
  const read = file.read(0, 10, { signal: reading.signal });
  reading.abort();
  await assert.rejects(read, { name: 'AbortError' });

  const fixture = await buildArtifact(TREE_ENTRIES, { inlineRaw: false });
  const asset = new VerifiedAsset({ cid: fixture.anchor, router: stalled });
  const fetching = new AbortController();
  const bytes = asset.bytes('style.json', { signal: fetching.signal });
  fetching.abort();
  await assert.rejects(bytes, { name: 'AbortError' });
});
