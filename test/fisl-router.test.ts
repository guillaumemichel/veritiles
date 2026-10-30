import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FetchContext, Router, Verdict } from '../packages/router/src/index.ts';

import { fisl, interleave } from '../packages/fisl-router/src/index.ts';

const INDEX = 'https://index.example/';
const CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';

// An index answering lookups from a table, in table order, logging every
// request with its headers.
function index(answers: Record<string, unknown[]>, status = 200) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    init?.signal?.throwIfAborted();
    const cid = /\/routing\/locations\/([^/]+)\/jsonl$/.exec(url)?.[1];
    if (cid === undefined) return new Response('ok');
    if (status !== 200) return new Response('{"error":"internal"}', { status });
    return new Response((answers[cid] ?? []).map((record) => JSON.stringify(record)).join('\n'));
  }) as typeof fetch;
  return { fetchFn, requests };
}

const at = (...urls: string[]) => ({ addrs: urls.map((url) => ({ url })) });

async function* listed(urls: string[]): AsyncGenerator<string> {
  yield* urls;
}

function stream(router: Router, cid: string, defaults: string[] = []): AsyncIterator<string> {
  return (router.locate(cid, { defaults: listed(defaults) }) as AsyncIterable<string>)[Symbol.asyncIterator]();
}

// Everything the router yields for a CID, after the page's own `defaults`.
async function located(router: Router, cid: string, defaults: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for await (const url of router.locate(cid, { defaults: listed(defaults) }) as AsyncIterable<string>) out.push(url);
  return out;
}

// A request context as a reader hands it over.
function context(next: typeof fetch, cid = CID, location = 'https://a.example/x'): FetchContext {
  const verdict = new Promise<Verdict>(() => {});
  return { cid, location, verdict, next: (url, init) => next(url, init) };
}

test("F-01 looks the CID up as FISL jsonl and yields every record's URLs, round by round", async () => {
  const { fetchFn, requests } = index({ [CID]: [at('https://many.example/0', 'https://many.example/1', 'https://many.example/2'), at('https://one.example/x')] });
  const router = fisl({ url: INDEX, fetchFn });
  assert.deepEqual(await located(router, CID), ['https://many.example/0', 'https://one.example/x', 'https://many.example/1', 'https://many.example/2']);
  assert.deepEqual(requests.map((r) => r.url), [`https://index.example/routing/locations/${CID}/jsonl`]);
  assert.equal(requests[0]!.headers.has('Authorization'), false);
});

test('F-02 select picks and orders the URLs from the records, and is read only as the reader asks', async () => {
  const { fetchFn } = index({ [CID]: [{ who: 'a', ...at('https://a.example/x') }, { who: 'b', ...at('https://b.example/x') }] });
  const seen: unknown[] = [];
  let taken = 0;
  const router = fisl({
    url: INDEX,
    fetchFn,
    *select(records, cid) {
      seen.push(cid, records.map((r) => r.fields.who));
      for (const record of [...records].reverse()) {
        taken++;
        yield record.urls[0]!;
      }
    },
  });
  const urls = stream(router, CID);
  assert.deepEqual(await urls.next(), { done: false, value: 'https://b.example/x' });
  assert.equal(taken, 1, 'the next URL waits until it is asked for');
  assert.deepEqual(await urls.next(), { done: false, value: 'https://a.example/x' });
  assert.deepEqual(await urls.next(), { done: true, value: undefined });
  assert.deepEqual(seen, [CID, ['a', 'b']]);
});

test("F-03 a failed lookup ends only its own half: the page's locations still come", async () => {
  const own = ['https://own.example/x'];
  assert.deepEqual(await located(fisl({ url: INDEX, fetchFn: index({}, 500).fetchFn }), CID, own), own);
  const down = (async () => {
    throw new TypeError('network');
  }) as typeof fetch;
  assert.deepEqual(await located(fisl({ url: INDEX, fetchFn: down }), CID, own), own);
  const broken = fisl({
    url: INDEX,
    fetchFn: index({ [CID]: [at('https://a.example/x')] }).fetchFn,
    select: () => {
      throw new Error('select failed');
    },
  });
  assert.deepEqual(await located(broken, CID, own), own);
});

test('F-04 a lookup, or a request through fetch, gives up after 10 s without an answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))) as typeof fetch;
  const router = fisl({ url: INDEX, fetchFn: hanging });
  const lookup = located(router, CID, ['https://own.example/x']);
  const content = router.fetch!('https://a.example/x', {}, context(hanging));
  const settled = { lookup: false, content: false };
  void lookup.finally(() => (settled.lookup = true));
  void content.catch(() => {}).finally(() => (settled.content = true));
  await new Promise(setImmediate);
  t.mock.timers.tick(9_999);
  await new Promise(setImmediate);
  assert.deepEqual(settled, { lookup: false, content: false }, 'both still waiting just before the deadline');
  t.mock.timers.tick(1);
  assert.deepEqual(await lookup, ['https://own.example/x'], 'the lookup half ended; the page kept its own');
  await assert.rejects(content, { name: 'TimeoutError' });
});

test("F-05 the page's own locations race the lookup; closing the stream aborts a lookup still out", async () => {
  let answer!: () => void;
  let aborted = false;
  const slow = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      answer = resolve;
      init?.signal?.addEventListener('abort', () => ((aborted = true), reject(init.signal!.reason)), { once: true });
    });
    return new Response(JSON.stringify(at('https://indexed.example/x')));
  }) as typeof fetch;
  const urls = stream(fisl({ url: INDEX, fetchFn: slow }), CID, ['https://own.example/x']);
  assert.deepEqual(await urls.next(), { done: false, value: 'https://own.example/x' }, 'the page first: it answers at once');
  const next = urls.next();
  answer();
  assert.deepEqual(await next, { done: false, value: 'https://indexed.example/x' }, 'then the lookup, as soon as it answers');

  const open = stream(fisl({ url: INDEX, fetchFn: slow }), CID, ['https://own.example/x']);
  await open.next();
  await open.return!(undefined);
  assert.equal(aborted, true);
});

test("F-06 fetch carries a request through the client's fetch as it is, the caller's abort included", async () => {
  const { fetchFn, requests } = index({});
  const router = fisl({ url: INDEX, fetchFn: async () => new Response('lookups only') });
  const res = await router.fetch!('https://a.example/x', { headers: { Range: 'bytes=0-9' } }, context(fetchFn));
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(requests.map((r) => [r.url, r.headers.get('Range'), r.headers.has('Authorization')]), [['https://a.example/x', 'bytes=0-9', false]]);
  const caller = new AbortController();
  caller.abort(new Error('the reader left'));
  await assert.rejects(router.fetch!('https://a.example/x', { signal: caller.signal }, context(fetchFn)), /the reader left/);
});

test("F-07 interleave takes each group's first, then each one's second", () => {
  assert.deepEqual(interleave([['a0', 'a1', 'a2'], [], ['b0'], ['c0', 'c1']]), ['a0', 'b0', 'c0', 'a1', 'c1', 'a2']);
  assert.deepEqual(interleave([]), []);
});
