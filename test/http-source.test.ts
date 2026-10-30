// The plain GET every reader shares: a whole file below a base URL, its
// body capped and handed up unverified, a failed request judged here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpSource } from '../packages/core/src/http-source.ts';
import type { FetchContext, Router, Verdict } from '../packages/router/src/index.ts';
import { VerificationError } from '../packages/core/src/verify.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { rangeFetch } from './helpers/host.ts';

const data = deterministicBytes(3000, 1);

test('fetchWhole is a plain GET with no Range header', async () => {
  let sawRange = false;
  const source = new HttpSource('.', {
    fetchFn: rangeFetch(new Map([['proofs', data]]), {
      onRequest: (_, h) => (sawRange ||= Boolean(h?.Range)),
    }),
  });
  assert.deepEqual((await source.fetchWhole('proofs', 4096)).bytes, data);
  assert.equal(sawRange, false);
});

test('fetchWhole caps the body read', async () => {
  const source = new HttpSource('.', {
    fetchFn: rangeFetch(new Map([['proofs', data]])),
  });
  await assert.rejects(source.fetchWhole('proofs', 100), VerificationError);
});

test('HTTP errors surface with the status', async () => {
  const source = new HttpSource('.', {
    fetchFn: (async () => new Response('nope', { status: 404 })) as typeof fetch,
  });
  await assert.rejects(source.fetchWhole('metadata.json', 4096), /HTTP 404/);
});

test('a body-less response is a verification error, not a crash', async () => {
  const source = new HttpSource('.', {
    fetchFn: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  await assert.rejects(source.fetchWhole('metadata.json', 4096), /no body/);
});

// --- A5: the empty-path tweak (decision 9) ---

test('R-01 fetchWhole("") requests the base itself with no trailing slash', async () => {
  const urls: string[] = [];
  const source = new HttpSource('https://h/style.json', {
    fetchFn: rangeFetchAt('https://h/style.json', data, urls),
  });
  await source.fetchWhole('', 4096);
  assert.deepEqual(urls, ['https://h/style.json']);
});

test('R-02 trailing slashes are stripped once; members request base/<path>', async () => {
  const urls: string[] = [];
  const source = new HttpSource('https://h/fonts///', {
    fetchFn: rangeFetchAt('https://h/fonts/a.pbf', data, urls),
  });
  await source.fetchWhole('a.pbf', 4096);
  assert.deepEqual(urls, ['https://h/fonts/a.pbf']);
});

test('R-03 a nonempty path still percent-encodes each segment', async () => {
  const urls: string[] = [];
  const source = new HttpSource('https://h', {
    fetchFn: rangeFetchAt('https://h/x%20y/z', data, urls),
  });
  await source.fetchWhole('x y/z', 4096);
  assert.deepEqual(urls, ['https://h/x%20y/z']);
});

// Serves `bytes` for any URL, recording each requested URL.
function rangeFetchAt(_expect: string, bytes: Uint8Array, log: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    log.push(String(url));
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof fetch;
}

// --- Verdicts (SPEC §6): a router that carries the requests hears each outcome ---

// A source whose requests a router carries: it answers through `answer`, or
// the client's own fetch, logging every context it is handed.
function routedSource(answer?: () => Response | Promise<Response>) {
  const contexts: FetchContext[] = [];
  const router: Router = {
    locate: () => [],
    fetch: (url, init, context) => {
      contexts.push(context);
      return answer === undefined ? context.next(url, init) : Promise.resolve(answer());
    },
  };
  const source = new HttpSource('https://h/file', { fetchFn: rangeFetch(new Map([['file', data]])), route: { router, cid: 'bafkfile', location: 'https://h/file' } });
  return { source, contexts };
}

test("HS-V1: a routed plain GET goes out at once; a body is its reader's to judge, a failure settles its own verdict", async () => {
  const { source, contexts } = routedSource();
  const pending = source.fetchWhole('', 4096);
  assert.equal(contexts.length, 1, 'handed to the router synchronously');
  const body = await pending;
  assert.deepEqual(body.bytes, data);
  body.settle('verified');
  assert.equal(await contexts[0]!.verdict, 'verified');

  const outcome = async (answer: () => Response | Promise<Response>): Promise<Verdict> => {
    const { source, contexts } = routedSource(answer);
    await assert.rejects(source.fetchWhole('', 100));
    return contexts[0]!.verdict;
  };
  assert.equal(await outcome(() => new Response('nf', { status: 404 })), 'failed');
  assert.equal(await outcome(() => Promise.reject(new TypeError('network'))), 'failed');
  assert.equal(await outcome(() => new Response(null, { status: 200 })), 'rejected', 'no body');
  assert.equal(await outcome(() => new Response(new Uint8Array(200), { status: 200 })), 'rejected', 'over its cap');
});
