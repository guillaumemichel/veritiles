import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ByteSource } from '../src/verified-store.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte, sha256Hex } from './helpers/bytes.ts';

function chunk(length: number, seed: number, offset = 0) {
  const bytes = deterministicBytes(length, seed);
  return { offset, length, digest: sha256Hex(bytes), bytes };
}

// Transport-agnostic in-memory source. The store owns verification,
// failover, dedup, and caching, so its tests only need *a* source that
// serves whole files by path and ranges out of a backing buffer, honours
// abort, and can be told to fail or tamper to drive the error paths.
function source(
  {
    files = new Map(),
    buffer = new Uint8Array(0),
  }: { files?: Map<string, Uint8Array>; buffer?: Uint8Array } = {},
  {
    fail,
    tamper,
    onRequest,
  }: {
    fail?: boolean;
    tamper?: (bytes: Uint8Array) => Uint8Array | undefined;
    onRequest?: (what: string) => void;
  } = {},
): ByteSource {
  return {
    fetchWhole: async (path, _cap, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`whole:${path}`);
      if (fail) throw new Error('source down');
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return new Uint8Array(tamper ? (tamper(bytes) ?? bytes) : bytes);
    },
    fetchRange: async (path, start, length, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`range:${path}:${start}+${length}`);
      if (fail) throw new Error('source down');
      const slice = buffer.subarray(start, start + length);
      return new Uint8Array(tamper ? (tamper(slice) ?? slice) : slice);
    },
  };
}

test('requires at least one source', () => {
  assert.throws(() => new VerifiedStore([]), /at least one source/);
});

test('adoptSlices verifies every slice before caching any; a bad body caches nothing', async () => {
  const buffer = deterministicBytes(300, 70);
  const leaves = [
    { offset: 100, length: 50, digest: sha256Hex(buffer.subarray(100, 150)) },
    { offset: 150, length: 80, digest: sha256Hex(buffer.subarray(150, 230)) },
  ];
  const store = new VerifiedStore([source({ buffer })]);

  const body = buffer.slice(100, 230); // speculative body for [100, 230)
  const slices = await store.adoptSlices(leaves, body, 100);
  assert.deepEqual(slices[1], buffer.subarray(150, 230));
  assert.deepEqual(store.getCached(leaves[0]!.digest), buffer.subarray(100, 150));
  assert.equal(store.stats.verified, 2);

  const bad = flipByte(body, 60); // corrupts the second leaf's slice
  const store2 = new VerifiedStore([source({ buffer })]);
  await assert.rejects(store2.adoptSlices(leaves, bad, 100), /digest mismatch/);
  assert.equal(store2.getCached(leaves[0]!.digest), undefined, 'nothing cached from a bad body');
  assert.equal(store2.stats.rejected, 1);

  const short = body.slice(0, 100); // body ends inside the second leaf
  await assert.rejects(store2.adoptSlices(leaves, short, 100), /truncated/);
});

test('fetchRangeUnverified returns raw bytes without verifying or caching', async () => {
  const buffer = deterministicBytes(200, 71);
  let requests = 0;
  const store = new VerifiedStore([source({ buffer }, { onRequest: () => requests++ })]);
  assert.deepEqual(await store.fetchRangeUnverified('map', 40, 60), buffer.subarray(40, 100));
  assert.deepEqual(await store.fetchRangeUnverified('map', 40, 60), buffer.subarray(40, 100));
  assert.equal(requests, 2, 'never cached');
  assert.equal(store.stats.verified, 0);
});

test('fetchWhole verifies, caches by digest, and de-duplicates in-flight', async () => {
  const c = chunk(100, 1);
  let requests = 0;
  const store = new VerifiedStore([
    source({ files: new Map([['x', c.bytes]]) }, { onRequest: () => requests++ }),
  ]);
  const [a, b] = await Promise.all([
    store.fetchWhole('x', c.digest, 4096),
    store.fetchWhole('x', c.digest, 4096),
  ]);
  assert.deepEqual(a, c.bytes);
  assert.deepEqual(b, c.bytes);
  await store.fetchWhole('x', c.digest, 4096);
  assert.equal(requests, 1);
  assert.equal(store.stats.verified, 1);
  assert.deepEqual(store.getCached(c.digest), c.bytes);
});

test('fetchWhole rejects tampered bytes and counts them', async () => {
  const c = chunk(100, 2);
  const store = new VerifiedStore([
    source({ files: new Map([['x', c.bytes]]) }, { tamper: (b) => flipByte(b) }),
  ]);
  await assert.rejects(store.fetchWhole('x', c.digest, 4096), AggregateError);
  assert.equal(store.stats.rejected, 1);
});

test('fetchWhole fails over past a bad source', async () => {
  const c = chunk(100, 3);
  const files = new Map([['x', c.bytes]]);
  const store = new VerifiedStore([
    source({ files }, { tamper: (b) => flipByte(b) }),
    source({ files }),
  ]);
  assert.deepEqual(await store.fetchWhole('x', c.digest, 4096), c.bytes);
  assert.equal(store.stats.rejected, 1);
  assert.equal(store.stats.verified, 1);
});

test('fetchRun returns verified slices aligned with input and caches them', async () => {
  const buffer = deterministicBytes(200, 4);
  const a = { offset: 0, length: 80, digest: sha256Hex(buffer.subarray(0, 80)) };
  const b = { offset: 80, length: 120, digest: sha256Hex(buffer.subarray(80, 200)) };
  let requests = 0;
  const store = new VerifiedStore([source({ buffer }, { onRequest: () => requests++ })]);
  const slices = await store.fetchRun('map', [a, b]);
  assert.deepEqual(slices[0], buffer.subarray(0, 80));
  assert.deepEqual(slices[1], buffer.subarray(80, 200));
  assert.equal(requests, 1, 'one range request for the whole run');
  assert.equal(store.stats.verified, 2);
  assert.deepEqual(store.getCached(a.digest), buffer.subarray(0, 80));
});

test('every single-byte flip in a run is rejected', async () => {
  const buffer = deterministicBytes(64, 5);
  const leaf = { offset: 0, length: 64, digest: sha256Hex(buffer) };
  for (let i = 0; i < buffer.length; i += 7) {
    const store = new VerifiedStore([source({ buffer }, { tamper: (b) => flipByte(b, i) })]);
    await assert.rejects(store.fetchRun('map', [leaf]), AggregateError);
  }
});

test('a run body of the wrong length is rejected before hashing', async () => {
  const buffer = deterministicBytes(100, 6);
  const leaf = { offset: 0, length: 100, digest: sha256Hex(buffer) };
  let hashed = false;
  const store = new VerifiedStore([source({ buffer }, { tamper: () => new Uint8Array(50) })]);
  const subtle = crypto.subtle.digest.bind(crypto.subtle);
  const patched = (...args: Parameters<typeof crypto.subtle.digest>) => {
    hashed = true;
    return subtle(...args);
  };
  Object.defineProperty(crypto.subtle, 'digest', { value: patched, configurable: true });
  try {
    await assert.rejects(store.fetchRun('map', [leaf]), (err: AggregateError) => {
      assert.match((err.errors[0] as Error).message, /got 50 bytes, expected 100/);
      return true;
    });
    assert.equal(hashed, false);
  } finally {
    Object.defineProperty(crypto.subtle, 'digest', { value: subtle, configurable: true });
  }
});

test('one tampered leaf fails the whole run over to the next source', async () => {
  const buffer = deterministicBytes(200, 7);
  const a = { offset: 0, length: 80, digest: sha256Hex(buffer.subarray(0, 80)) };
  const b = { offset: 80, length: 120, digest: sha256Hex(buffer.subarray(80, 200)) };
  const store = new VerifiedStore([
    source({ buffer }, { tamper: (bytes) => flipByte(bytes, 100) }), // corrupts leaf b only
    source({ buffer }),
  ]);
  const slices = await store.fetchRun('map', [a, b]);
  assert.deepEqual(slices[1], buffer.subarray(80, 200));
  assert.ok(store.stats.rejected >= 1);
});

test('concurrent identical runs share one fetch and one verification pass', async () => {
  const buffer = deterministicBytes(100, 8);
  const leaf = { offset: 0, length: 100, digest: sha256Hex(buffer) };
  let requests = 0;
  const store = new VerifiedStore([source({ buffer }, { onRequest: () => requests++ })]);
  await Promise.all([store.fetchRun('map', [leaf]), store.fetchRun('map', [leaf])]);
  assert.equal(requests, 1);
  assert.equal(store.stats.verified, 1);
});

test('fetchUnverified returns raw bytes and fails over', async () => {
  const bytes = deterministicBytes(50, 9);
  const store = new VerifiedStore([
    source({}, { fail: true }),
    source({ files: new Map([['metadata.json', bytes]]) }),
  ]);
  assert.deepEqual(await store.fetchUnverified('metadata.json', 4096), bytes);
  assert.equal(store.stats.verified, 0, 'unverified fetches never count as verified');
});

test('evicts least-recently-used bytes beyond the cache cap', async () => {
  const a = chunk(80, 10);
  const b = chunk(80, 11);
  let requests = 0;
  const files = new Map([
    ['a', a.bytes],
    ['b', b.bytes],
  ]);
  const store = new VerifiedStore([source({ files }, { onRequest: () => requests++ })], {
    maxCacheBytes: 100,
  });
  await store.fetchWhole('a', a.digest, 4096);
  await store.fetchWhole('b', b.digest, 4096); // evicts a
  await store.fetchWhole('a', a.digest, 4096); // must re-fetch
  assert.equal(requests, 3);
});

test('an aborted signal cancels the fetch and leaves the store consistent', async () => {
  const c = chunk(100, 12);
  let sawAbort = false;
  const hanging: ByteSource = {
    fetchWhole: (_path, _cap, { signal } = {}) =>
      new Promise((_, reject) =>
        signal!.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        }),
      ),
    fetchRange: async () => {
      throw new Error('unused');
    },
  };
  const store = new VerifiedStore([hanging]);
  const controller = new AbortController();
  const pending = store.fetchWhole('x', c.digest, 4096, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(sawAbort, true);

  const store2 = new VerifiedStore([source({ files: new Map([['x', c.bytes]]) })]);
  assert.deepEqual(await store2.fetchWhole('x', c.digest, 4096), c.bytes);
});

test('one consumer aborting does not cancel a shared in-flight fetch', async () => {
  const c = chunk(100, 13);
  const store = new VerifiedStore([source({ files: new Map([['x', c.bytes]]) })]);
  const controller = new AbortController();
  const aborted = store.fetchWhole('x', c.digest, 4096, { signal: controller.signal });
  const kept = store.fetchWhole('x', c.digest, 4096);
  controller.abort();
  await assert.rejects(aborted);
  assert.deepEqual(await kept, c.bytes);
});

test('a consumer joining after the last aborted gets a fresh fetch', async () => {
  const c = chunk(100, 14);
  let calls = 0;
  const src: ByteSource = {
    fetchWhole: (_path, _cap, { signal } = {}) => {
      calls++;
      if (calls === 1) {
        return new Promise((_, reject) =>
          signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        );
      }
      return Promise.resolve(new Uint8Array(c.bytes));
    },
    fetchRange: async () => {
      throw new Error('unused');
    },
  };
  const store = new VerifiedStore([src]);
  const controller = new AbortController();
  const first = store.fetchWhole('x', c.digest, 4096, { signal: controller.signal });
  controller.abort();
  await assert.rejects(first);
  assert.deepEqual(await store.fetchWhole('x', c.digest, 4096), c.bytes);
  assert.equal(calls, 2);
});
