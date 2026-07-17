import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodePath,
  RangeBlockedError,
  RangeSource,
  RangeUnsupportedError,
} from '../src/range-source.ts';
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
  const bytes = await source.fetchRange('map.pmtiles', 100, 900);
  assert.deepEqual(bytes, data.subarray(100, 1000));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.h!.Range, 'bytes=100-999');
});

test('fetchWhole is a plain GET with no Range header', async () => {
  let sawRange = false;
  const source = new RangeSource('.', {
    fetchFn: rangeFetch(new Map([['proofs', data]]), {
      onRequest: (_, h) => (sawRange ||= Boolean(h?.Range)),
    }),
  });
  assert.deepEqual(await source.fetchWhole('proofs', 4096), data);
  assert.equal(sawRange, false);
});

test('fetchWhole caps the body read', async () => {
  const source = new RangeSource('.', {
    fetchFn: rangeFetch(new Map([['proofs', data]])),
  });
  await assert.rejects(source.fetchWhole('proofs', 100), VerificationError);
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

test('HTTP errors surface with the status', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async () => new Response('nope', { status: 404 })) as typeof fetch,
  });
  await assert.rejects(source.fetchWhole('metadata.json', 4096), /HTTP 404/);
});

test('a body-less response is a verification error, not a crash', async () => {
  const source = new RangeSource('.', {
    fetchFn: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  await assert.rejects(source.fetchWhole('metadata.json', 4096), /no body/);
});

test('an aborted signal rejects', async () => {
  const source = new RangeSource('.', { fetchFn: rangeFetch(new Map([['map.pmtiles', data]])) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.fetchRange('map.pmtiles', 0, 100, { signal: controller.signal }));
});

test('encodePath percent-encodes each segment', () => {
  assert.equal(
    encodePath('fonts/Noto Sans Regular/0-255.pbf'),
    'fonts/Noto%20Sans%20Regular/0-255.pbf',
  );
});

// --- A5: the empty-path tweak (decision 9) ---

test('R-01 fetchWhole("") requests the base itself with no trailing slash', async () => {
  const urls: string[] = [];
  const source = new RangeSource('https://h/style.json', {
    fetchFn: rangeFetchAt('https://h/style.json', data, urls),
  });
  await source.fetchWhole('', 4096);
  assert.deepEqual(urls, ['https://h/style.json']);
});

test('R-02 trailing slashes are stripped once; members request base/<path>', async () => {
  const urls: string[] = [];
  const source = new RangeSource('https://h/fonts///', {
    fetchFn: rangeFetchAt('https://h/fonts/a.pbf', data, urls),
  });
  await source.fetchWhole('a.pbf', 4096);
  assert.deepEqual(urls, ['https://h/fonts/a.pbf']);
});

test('R-03 a nonempty path still percent-encodes each segment', async () => {
  const urls: string[] = [];
  const source = new RangeSource('https://h', {
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
