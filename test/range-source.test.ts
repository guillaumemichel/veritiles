// Byte ranges over HTTP: one exact single-`Range` GET per run, a 206
// demanded, and the diagnostics for hosts that cannot serve ranges.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RangeBlockedError,
  RangeSource,
  RangeUnsupportedError,
} from '../src/range-source.ts';
import type { FetchContext, Router, Verdict } from '../src/router.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { rangeFetch } from './helpers/host.ts';

const data = deterministicBytes(3000, 1);

test('fetchRange issues one exact Range request and returns its bytes', async () => {
  const requests: { url: string; h?: Record<string, string> }[] = [];
  const source = new RangeSource('.', {
    fetchFn: rangeFetch(new Map([['map.pmtiles', data]]), {
      onRequest: (url, h) => requests.push({ url, h }),
    }),
  });
  const { bytes } = await source.fetchRange('map.pmtiles', 100, 900);
  assert.deepEqual(bytes, data.subarray(100, 1000));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.h!.Range, 'bytes=100-999');
});

test('a 200 to a ranged request is refused (host ignores Range)', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async () => new Response(new Uint8Array(data), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100), RangeUnsupportedError);
});

test('a 206 body longer than the requested run is cut off and rejected', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async () => new Response(new Uint8Array(data), { status: 206 })) as typeof fetch,
  });
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100), VerificationError);
});

test('a ranged TypeError after a good plain GET is the CORS-preflight diagnostic', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async (_url: unknown, init?: RequestInit) => {
      if ((init?.headers as Record<string, string>)?.Range) {
        throw new TypeError('NetworkError'); // preflight blocked
      }
      return new Response(new Uint8Array(data), { status: 200 });
    }) as typeof fetch,
  });
  await source.fetchWhole('metadata.json', 4096); // plain GET succeeded
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100), RangeBlockedError);
});

test('a ranged TypeError with no prior plain GET stays a TypeError', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async () => {
      throw new TypeError('NetworkError');
    }) as typeof fetch,
  });
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100), TypeError);
});

test('an aborted signal rejects', async () => {
  const source = new RangeSource('.', { fetchFn: rangeFetch(new Map([['map.pmtiles', data]])) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100, { signal: controller.signal }));
});

// --- Verdicts (SPEC §6): a router that carries the requests hears each outcome ---

// A source whose requests a router carries: it answers through `answer`, or
// the client's own fetch, logging every context it is handed.
function routedSource(fetchFn: typeof fetch, answer?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const contexts: FetchContext[] = [];
  const router: Router = {
    locate: () => [],
    fetch: (url, init, context) => {
      contexts.push(context);
      return answer === undefined ? context.next(url, init) : Promise.resolve(answer(url, init));
    },
  };
  const source = new RangeSource('https://h/map', { fetchFn, route: { router, cid: 'bafkmap', location: 'https://h/map' } });
  return { source, contexts };
}

test('RS-V1: a routed request goes out at once with a fresh context; a body is its reader\'s to judge', async () => {
  const { source, contexts } = routedSource(rangeFetch(new Map([['map', data]])));
  const pending = source.fetchRange('', 0, 100);
  assert.equal(contexts.length, 1, 'handed to the router synchronously');
  const body = await pending;
  assert.deepEqual(body.bytes, data.subarray(0, 100));
  assert.deepEqual({ cid: contexts[0]!.cid, location: contexts[0]!.location }, { cid: 'bafkmap', location: 'https://h/map' });
  await source.fetchWhole('', 4096);
  assert.notEqual(contexts[1]!.verdict, contexts[0]!.verdict, 'one verdict per request');
  body.settle('verified');
  body.settle('rejected');
  assert.equal(await contexts[0]!.verdict, 'verified', 'the first report counts');
});

test('RS-V2: a request that fails settles its own verdict: failed, rejected for a broken body, unused when aborted', async () => {
  const outcome = async (answer: () => Response | Promise<Response>, ranged = true, signal?: AbortSignal): Promise<Verdict> => {
    const { source, contexts } = routedSource(rangeFetch(new Map()), answer);
    const request = ranged ? source.fetchRange('', 0, 100, { signal }) : source.fetchWhole('', 100, { signal });
    await assert.rejects(request);
    return contexts[0]!.verdict;
  };
  assert.equal(await outcome(() => new Response('nf', { status: 404 })), 'failed');
  assert.equal(await outcome(() => new Response(new Uint8Array(10), { status: 200 })), 'failed', 'a host ignoring Range');
  assert.equal(await outcome(() => Promise.reject(new TypeError('network'))), 'failed');
  assert.equal(await outcome(() => { throw new Error('router refuses'); }), 'failed', 'a router fetch that throws');
  assert.equal(await outcome(() => new Response(new Uint8Array(200), { status: 206 })), 'rejected', 'longer than asked');
  assert.equal(await outcome(() => new Response(null, { status: 200 }), false), 'rejected', 'no body');
  const controller = new AbortController();
  controller.abort();
  const aborted = (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return new Response(new Uint8Array(100), { status: 206 });
  };
  const { source, contexts } = routedSource(rangeFetch(new Map()), aborted);
  await assert.rejects(source.fetchRange('', 0, 100, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await contexts[0]!.verdict, 'unused');
});

test('RS-V3: context.next is the client\'s own fetch', async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(new Uint8Array(data.subarray(0, 10)), { status: 206 });
  }) as typeof fetch;
  const { source } = routedSource(fetchFn);
  await source.fetchRange('', 0, 10);
  assert.deepEqual(seen, ['https://h/map']);
});

test("RS-V4: a body is the source's own copy: rewriting the producer's buffer later changes nothing", async () => {
  const produced = Uint8Array.from(data.subarray(0, 100));
  const fetchFn = (async () =>
    new Response(new ReadableStream({ start: (c) => (c.enqueue(produced), c.close()) }), { status: 206 })) as typeof fetch;
  const { bytes } = await new RangeSource('https://h/map', { fetchFn }).fetchRange('', 0, 100);
  produced.fill(0);
  assert.deepEqual(bytes, data.subarray(0, 100));
});
