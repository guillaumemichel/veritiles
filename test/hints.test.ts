// Hints parser + resolver (PLAN-hints S1): tolerant salvage of an untrusted
// JSON document, and a lazy, memoized, capped resolver over one or more of
// them. Request accounting is first-class — "no fetch happened" is asserted.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { cidToText, parseCid } from '../src/cid.ts';
import { HintResolver, parseHintsDocument } from '../src/hints.ts';
import { MAX_HINT_BYTES } from '../src/limits.ts';
import type { FetchFn } from '../src/range-source.ts';
import { withPageUrl } from './helpers/serve-hints.ts';

const SHA2_256 = 0x12;
const digest = (seed: number) => Digest.create(SHA2_256, new Uint8Array(32).fill(seed));
const rawCid = (seed: number) => CID.createV1(0x55, digest(seed)).toString();
const cborCid = (seed: number) => CID.createV1(0x71, digest(seed)).toString();

const DOC = 'https://host.example/dir/hints.json';

// A routed fetch over a fixed set of document URLs, recording every request.
// A value may be a string body (200), or {status} / {body} to force either.
function serveDocs(docs: Record<string, string | { status?: number; body?: string }>) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    (init as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted();
    requests.push(url);
    const doc = docs[url];
    if (doc === undefined) return new Response('nf', { status: 404 });
    if (typeof doc === 'string') return new Response(doc, { status: 200 });
    if (doc.status !== undefined) return new Response('forced', { status: doc.status });
    return new Response(doc.body ?? '', { status: 200 });
  }) as FetchFn;
  return { fetchFn, requests };
}

const body = (hints: Record<string, unknown>) => JSON.stringify({ hints });

// --- Parser (HP-01 .. HP-11) ---

test('HP-01: valid two-entry doc parses; array order preserved', () => {
  const a = cborCid(1);
  const b = rawCid(2);
  const parsed = parseHintsDocument(
    body({ [a]: ['https://n/world.pmtiles.proofs'], [b]: ['https://cdn-a/x', 'https://cdn-b/x'] }),
    DOC,
  );
  assert.deepEqual(parsed?.get(a), ['https://n/world.pmtiles.proofs']);
  assert.deepEqual(parsed?.get(b), ['https://cdn-a/x', 'https://cdn-b/x']);
});

test('HP-02: non-object documents parse to null', () => {
  for (const text of ['[1,2]', '"str"', '42', 'null', 'not json']) {
    assert.equal(parseHintsDocument(text, DOC), null, text);
  }
});

test('HP-03: {} and missing/non-object hints yield an empty map, not null', () => {
  for (const text of ['{}', '{"hints":5}', '{"hints":null}', '{"hints":[1]}']) {
    const parsed = parseHintsDocument(text, DOC);
    assert.ok(parsed instanceof Map, text);
    assert.equal(parsed.size, 0, text);
  }
});

test('HP-04: invalid CID keys are ignored, valid siblings salvaged', () => {
  const good = rawCid(3);
  const cidV0 = CID.createV0(digest(4)).toString();
  const dagPb = CID.createV1(0x70, digest(5)).toString();
  const parsed = parseHintsDocument(
    body({ 'not-a-cid': ['https://n/x'], [cidV0]: ['https://n/x'], [dagPb]: ['https://n/x'], [good]: ['https://n/g'] }),
    DOC,
  );
  assert.deepEqual([...parsed!.keys()], [good]);
});

test('HP-05: non-array value ignored; a mixed array keeps strings, drops the rest', () => {
  const a = rawCid(6);
  const b = rawCid(7);
  const parsed = parseHintsDocument(
    body({ [a]: 'https://n/x', [b]: ['https://n/keep', 42, null, { u: 1 }, 'https://n/keep2'] }),
    DOC,
  );
  assert.equal(parsed!.has(a), false);
  assert.deepEqual(parsed!.get(b), ['https://n/keep', 'https://n/keep2']);
});

test('HP-06: ./ and ../ resolve against the doc URL; absolute passes; trailing / stripped', () => {
  const a = rawCid(8);
  const parsed = parseHintsDocument(
    body({ [a]: ['./x', '../y/', 'https://other/z/', 'https://other/w'] }),
    DOC,
  );
  assert.deepEqual(parsed!.get(a), [
    'https://host.example/dir/x',
    'https://host.example/y',
    'https://other/z',
    'https://other/w',
  ]);
});

test('HP-07: non-http(s) schemes dropped post-resolution; http/https kept', () => {
  const a = rawCid(9);
  const parsed = parseHintsDocument(
    body({ [a]: ['file:///etc/passwd', 'data:text/plain,x', 'javascript:alert(1)', 'ftp://h/x', 'http://h/ok', 'https://h/ok2'] }),
    DOC,
  );
  assert.deepEqual(parsed!.get(a), ['http://h/ok', 'https://h/ok2']);
});

test('HP-08: a URL over 4,096 UTF-8 bytes is dropped, shorter siblings kept', () => {
  const a = rawCid(10);
  const huge = `https://h/${'a'.repeat(5000)}`;
  const parsed = parseHintsDocument(body({ [a]: [huge, 'https://h/small'] }), DOC);
  assert.deepEqual(parsed!.get(a), ['https://h/small']);
});

test('HP-09: duplicate JSON keys resolve last-wins', () => {
  const a = rawCid(11);
  const text = `{"hints":{"${a}":["https://h/first"],"${a}":["https://h/last"]}}`;
  assert.deepEqual(parseHintsDocument(text, DOC)!.get(a), ['https://h/last']);
});

test('HP-10: unknown top-level and non-CID keys are ignored', () => {
  const a = rawCid(12);
  const parsed = parseHintsDocument(
    JSON.stringify({ version: 1, extra: { any: 'thing' }, hints: { note: 'ignored', [a]: ['https://h/x'] } }),
    DOC,
  );
  assert.deepEqual([...parsed!.keys()], [a]);
});

test('HP-12: a URL string the URL parser itself rejects is dropped, siblings kept', () => {
  const a = rawCid(13);
  const parsed = parseHintsDocument(body({ [a]: ['http://', 'https://h/ok'] }), DOC);
  assert.deepEqual(parsed!.get(a), ['https://h/ok']);
});

test('HP-13: a CID whose every URL is dropped is omitted entirely', () => {
  const a = rawCid(14);
  const b = rawCid(15);
  const parsed = parseHintsDocument(body({ [a]: ['file:///x', 'ftp://y'], [b]: ['https://h/ok'] }), DOC);
  assert.deepEqual([...parsed!.keys()], [b], 'the all-dropped CID contributes no empty entry');
});

// --- Resolver (HR-01 .. HR-07) ---

test('HR-00: an explicit hints option that is empty or blank throws at construction', () => {
  const { fetchFn } = serveDocs({});
  assert.throws(() => new HintResolver({ hints: [], fetchFn }), /non-empty list/);
  assert.throws(() => new HintResolver({ hints: [''], fetchFn }), /non-empty list/);
  assert.throws(() => new HintResolver({ hints: [42 as unknown as string], fetchFn }), /non-empty list/);
});

test('HR-01: constructing performs no fetch; first urlsFor fetches', async () => {
  const a = cborCid(20);
  const { fetchFn, requests } = serveDocs({ [DOC]: body({ [a]: ['https://n/p'] }) });
  const r = new HintResolver({ hints: DOC, fetchFn });
  assert.deepEqual(requests, []);
  assert.deepEqual(await r.urlsFor(a), ['https://n/p']);
  assert.deepEqual(requests, [DOC]);
});

test('HR-02: a second urlsFor adds zero requests', async () => {
  const a = cborCid(21);
  const { fetchFn, requests } = serveDocs({ [DOC]: body({ [a]: ['https://n/p'] }) });
  const r = new HintResolver({ hints: DOC, fetchFn });
  await r.urlsFor(a);
  requests.length = 0;
  assert.deepEqual(await r.urlsFor(a), ['https://n/p']);
  assert.deepEqual(requests, []);
});

test('HR-03: a 404 yields empty and is refetched on the next call', async () => {
  const a = cborCid(22);
  const docs: Record<string, string | { status?: number }> = { [DOC]: { status: 404 } };
  const { fetchFn, requests } = serveDocs(docs);
  const r = new HintResolver({ hints: DOC, fetchFn });
  assert.deepEqual(await r.urlsFor(a), []);
  docs[DOC] = body({ [a]: ['https://n/late'] });
  assert.deepEqual(await r.urlsFor(a), ['https://n/late']);
  assert.equal(requests.length, 2, 'the failed document was refetched');
});

test('HR-04: multi-doc merge in option order, first-wins dedupe, 16-per-CID cap', async () => {
  const a = rawCid(23);
  const many = Array.from({ length: 20 }, (_, i) => `https://m/${i}`);
  const D1 = 'https://one/hints.json';
  const D2 = 'https://two/hints.json';
  const { fetchFn } = serveDocs({
    [D1]: body({ [a]: ['https://one/x', 'https://dup/y'] }),
    [D2]: body({ [a]: ['https://dup/y', ...many] }),
  });
  const r = new HintResolver({ hints: [D1, D2], fetchFn });
  const urls = await r.urlsFor(a);
  assert.equal(urls.length, 16, 'capped at 16');
  assert.deepEqual(urls.slice(0, 3), ['https://one/x', 'https://dup/y', 'https://m/0']);
  assert.equal(urls.filter((u) => u === 'https://dup/y').length, 1, 'first occurrence wins');
});

test('HR-05: the seventeenth document (explicit + probed) is never fetched', async () => {
  const a = rawCid(24);
  const explicit = Array.from({ length: 16 }, (_, i) => `https://d${i}/hints.json`);
  const docs: Record<string, string> = {};
  for (const u of explicit) docs[u] = body({});
  docs['https://probe/hints.json'] = body({ [a]: ['https://n/x'] });
  const { fetchFn, requests } = serveDocs(docs);
  const r = new HintResolver({ hints: explicit, fetchFn });
  await r.urlsFor(a);
  await r.probe('https://probe');
  assert.equal(requests.includes('https://probe/hints.json'), false, 'seventeenth doc skipped');
  assert.equal(requests.length, 16);
});

test('HR-09: more than 16 explicit documents throw at construction; duplicates collapse first', () => {
  const { fetchFn } = serveDocs({});
  const sixteen = Array.from({ length: 16 }, (_, i) => `https://d${i}/hints.json`);
  assert.throws(() => new HintResolver({ hints: [...sixteen, 'https://d16/hints.json'], fetchFn }), /more than 16 documents/);
  assert.doesNotThrow(() => new HintResolver({ hints: [...sixteen, 'https://d0/hints.json'], fetchFn }));
});

test('HR-06: default resolves against the page URL, is absent without one, explicit-relative without base throws', async () => {
  const a = cborCid(25);
  const { fetchFn, requests } = serveDocs({ 'https://page.example/app/hints.json': body({ [a]: ['https://n/p'] }) });
  const withBase = await withPageUrl('https://page.example/app/index.html', async () => new HintResolver({ fetchFn }));
  assert.deepEqual(await withBase.urlsFor(a), ['https://n/p']);
  assert.deepEqual(requests, ['https://page.example/app/hints.json']);

  requests.length = 0;
  const noBase = new HintResolver({ fetchFn });
  assert.deepEqual(await noBase.urlsFor(a), [], 'default absent with no base');
  assert.deepEqual(requests, [], 'no fetch without a base');
  assert.deepEqual(noBase.consulted(), []);

  assert.throws(() => new HintResolver({ hints: './rel.json', fetchFn }), /relative/);
});

test('HR-08: a fetched non-object document is not memoized and is refetched', async () => {
  const a = rawCid(27);
  const docs: Record<string, string> = { [DOC]: '[1,2,3]' }; // valid JSON, not an object
  const { fetchFn, requests } = serveDocs(docs);
  const r = new HintResolver({ hints: DOC, fetchFn });
  assert.deepEqual(await r.urlsFor(a), []);
  docs[DOC] = body({ [a]: ['https://n/late'] });
  assert.deepEqual(await r.urlsFor(a), ['https://n/late']);
  assert.equal(requests.length, 2, 'the non-object document was refetched, not memoized');
});

test('HR-07: the fixed 1 MiB cap — a body at the cap parses, one byte over is ignored', async () => {
  const a = rawCid(26);
  const D2 = 'https://two/hints.json';
  const { fetchFn } = serveDocs({
    [DOC]: padTo({ hints: { [a]: ['https://n/x'] } }, MAX_HINT_BYTES),
    [D2]: padTo({ hints: { [a]: ['https://n/x'] } }, MAX_HINT_BYTES + 1),
  });
  const atCap = new HintResolver({ hints: DOC, fetchFn });
  assert.deepEqual(await atCap.urlsFor(a), ['https://n/x']);
  const overCap = new HintResolver({ hints: D2, fetchFn });
  assert.deepEqual(await overCap.urlsFor(a), [], 'one byte over the cap is dropped');
});

test('HR-10: for one CID, explicit-document URLs merge before probed-document URLs', async () => {
  const a = rawCid(28);
  const { fetchFn } = serveDocs({
    [DOC]: body({ [a]: ['https://explicit/x'] }),
    'https://dir.example/hints.json': body({ [a]: ['https://probed/y', 'https://explicit/x'] }),
  });
  const r = new HintResolver({ hints: DOC, fetchFn });
  await r.probe('https://dir.example');
  assert.deepEqual(await r.urlsFor(a), ['https://explicit/x', 'https://probed/y'], 'probed last, first-wins dedupe');
});

test('HR-11: relative URLs resolve against the redirect target, not the requested URL', async () => {
  const a = rawCid(29);
  const fetchFn = (async () => {
    const res = new Response(body({ [a]: ['./world.pmtiles', 'https://abs.example/x'] }), { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://b.example/mirror/hints.json' });
    return res;
  }) as FetchFn;
  const r = new HintResolver({ hints: 'https://a.example/hints.json', fetchFn });
  assert.deepEqual(await r.urlsFor(a), ['https://b.example/mirror/world.pmtiles', 'https://abs.example/x']);
});

test('cidToText round-trips a canonical CID string', () => {
  for (const text of [rawCid(0), rawCid(127), cborCid(1), cborCid(200)]) {
    assert.equal(cidToText(parseCid(text, 'roundtrip')), text);
  }
});

// Pad a JSON document with a junk top-level key to exactly `target` UTF-8 bytes
// (all-ASCII, so string length equals byte length).
function padTo(doc: Record<string, unknown>, target: number): string {
  const skeleton = JSON.stringify({ ...doc, pad: '' });
  return JSON.stringify({ ...doc, pad: 'x'.repeat(target - skeleton.length) });
}
