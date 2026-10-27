import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DefaultLocations, Locator } from '../src/locations.ts';
import type { Router, Verdict } from '../src/router.ts';
import type { ByteSource } from '../src/verified-store.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { equalBytes, verifyDigest, VerificationError } from '../src/verify.ts';
import { deterministicBytes, flipByte, sha256Hex } from './helpers/bytes.ts';
import { storeOf } from './helpers/store.ts';

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
    verdicts,
  }: {
    fail?: boolean | (() => boolean);
    tamper?: (bytes: Uint8Array) => Uint8Array | undefined;
    onRequest?: (what: string) => void;
    verdicts?: Verdict[];
  } = {},
): ByteSource {
  const down = () => (typeof fail === 'function' ? fail() : fail === true);
  return {
    fetchWhole: async (path, _cap, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`whole:${path}`);
      if (down()) throw new Error('source down');
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return body(new Uint8Array(tamper ? (tamper(bytes) ?? bytes) : bytes), verdicts);
    },
    fetchRange: async (path, start, length, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`range:${path}:${start}+${length}`);
      if (down()) throw new Error('source down');
      const slice = buffer.subarray(start, start + length);
      return body(new Uint8Array(tamper ? (tamper(slice) ?? slice) : slice), verdicts);
    },
  };
}

// A response, its verdicts recorded when asked to.
const body = (bytes: Uint8Array, verdicts?: Verdict[]) => ({ bytes, settle: (v: Verdict) => verdicts?.push(v) });

test('adoptSlices verifies every slice before caching any; a bad body caches nothing', async () => {
  const buffer = deterministicBytes(300, 70);
  const leaves = [
    { offset: 100, length: 50, digest: sha256Hex(buffer.subarray(100, 150)) },
    { offset: 150, length: 80, digest: sha256Hex(buffer.subarray(150, 230)) },
  ];
  const store = storeOf([source({ buffer })]);

  const body = buffer.slice(100, 230); // speculative body for [100, 230)
  const slices = await store.adoptSlices(leaves, body, 100);
  assert.deepEqual(slices[1], buffer.subarray(150, 230));
  assert.deepEqual(store.getCached(leaves[0]!.digest), buffer.subarray(100, 150));
  assert.equal(store.stats.verified, 2);

  const bad = flipByte(body, 60); // corrupts the second leaf's slice
  const store2 = storeOf([source({ buffer })]);
  await assert.rejects(store2.adoptSlices(leaves, bad, 100), /digest mismatch/);
  assert.equal(store2.getCached(leaves[0]!.digest), undefined, 'nothing cached from a bad body');
  assert.equal(store2.stats.rejected, 1);

  const short = body.slice(0, 100); // body ends inside the second leaf
  await assert.rejects(store2.adoptSlices(leaves, short, 100), /truncated/);
});

test('fetchRangeUnverified returns raw bytes without verifying or caching', async () => {
  const buffer = deterministicBytes(200, 71);
  let requests = 0;
  const store = storeOf([source({ buffer }, { onRequest: () => requests++ })]);
  assert.deepEqual((await store.fetchRangeUnverified('map', 40, 60)).bytes, buffer.subarray(40, 100));
  assert.deepEqual((await store.fetchRangeUnverified('map', 40, 60)).bytes, buffer.subarray(40, 100));
  assert.equal(requests, 2, 'never cached');
  assert.equal(store.stats.verified, 0);
});

test('fetchWhole verifies, caches by digest, and de-duplicates in-flight', async () => {
  const c = chunk(100, 1);
  let requests = 0;
  const store = storeOf([
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
  const store = storeOf([
    source({ files: new Map([['x', c.bytes]]) }, { tamper: (b) => flipByte(b) }),
  ]);
  await assert.rejects(store.fetchWhole('x', c.digest, 4096), AggregateError);
  assert.equal(store.stats.rejected, 1);
});

test('fetchWhole fails over past a bad source', async () => {
  const c = chunk(100, 3);
  const files = new Map([['x', c.bytes]]);
  const store = storeOf([
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
  const store = storeOf([source({ buffer }, { onRequest: () => requests++ })]);
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
    const store = storeOf([source({ buffer }, { tamper: (b) => flipByte(b, i) })]);
    await assert.rejects(store.fetchRun('map', [leaf]), AggregateError);
  }
});

test('a run body of the wrong length is rejected before hashing', async () => {
  const buffer = deterministicBytes(100, 6);
  const leaf = { offset: 0, length: 100, digest: sha256Hex(buffer) };
  let hashed = false;
  const store = storeOf([source({ buffer }, { tamper: () => new Uint8Array(50) })]);
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
  const store = storeOf([
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
  const store = storeOf([source({ buffer }, { onRequest: () => requests++ })]);
  await Promise.all([store.fetchRun('map', [leaf]), store.fetchRun('map', [leaf])]);
  assert.equal(requests, 1);
  assert.equal(store.stats.verified, 1);
});

test('evicts least-recently-used bytes beyond the cache cap', async () => {
  const a = chunk(80, 10);
  const b = chunk(80, 11);
  let requests = 0;
  const files = new Map([
    ['a', a.bytes],
    ['b', b.bytes],
  ]);
  const store = storeOf([source({ files }, { onRequest: () => requests++ })], {
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
  const store = storeOf([hanging]);
  const controller = new AbortController();
  const pending = store.fetchWhole('x', c.digest, 4096, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(sawAbort, true);

  const store2 = storeOf([source({ files: new Map([['x', c.bytes]]) })]);
  assert.deepEqual(await store2.fetchWhole('x', c.digest, 4096), c.bytes);
});

test('one consumer aborting does not cancel a shared in-flight fetch', async () => {
  const c = chunk(100, 13);
  const store = storeOf([source({ files: new Map([['x', c.bytes]]) })]);
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
      return Promise.resolve(body(new Uint8Array(c.bytes)));
    },
    fetchRange: async () => {
      throw new Error('unused');
    },
  };
  const store = storeOf([src]);
  const controller = new AbortController();
  const first = store.fetchWhole('x', c.digest, 4096, { signal: controller.signal });
  controller.abort();
  await assert.rejects(first);
  assert.deepEqual(await store.fetchWhole('x', c.digest, 4096), c.bytes);
  assert.equal(calls, 2);
});

// --- A4: fetchChecked + tamper bans (A8) ---

const okCheck = (want: Uint8Array) => async (bytes: Uint8Array) => {
  if (!equalBytes(bytes, want)) throw new VerificationError('bytes do not match');
};

test('S-01 fetchChecked caches under cacheKey and de-duplicates concurrent callers', async () => {
  const bytes = deterministicBytes(100, 30);
  let requests = 0;
  const store = storeOf([source({ files: new Map([['x', bytes]]) }, { onRequest: () => requests++ })]);
  const [a, b] = await Promise.all([
    store.fetchChecked('x', 'key', 4096, okCheck(bytes)),
    store.fetchChecked('x', 'key', 4096, okCheck(bytes)),
  ]);
  assert.deepEqual(a, bytes);
  assert.deepEqual(b, bytes);
  assert.equal(requests, 1);
  assert.deepEqual(store.getCached('key'), bytes);
});

test('S-02 a verification failure bans the source for the rest of the session', async () => {
  const files = new Map([['x', deterministicBytes(100, 31)], ['y', deterministicBytes(80, 32)]]);
  const good = files.get('x')!;
  const log: string[] = [];
  const s1 = source({ files }, { onRequest: (w) => log.push(`s1:${w}`), tamper: (b) => flipByte(b) });
  const s2 = source({ files }, { onRequest: (w) => log.push(`s2:${w}`) });
  const store = storeOf([s1, s2]);

  assert.deepEqual(await store.fetchChecked('x', 'kx', 4096, okCheck(good)), good);
  assert.equal(store.stats.rejected, 1);
  assert.equal(store.stats.verified, 1);

  log.length = 0;
  await store.fetchChecked('y', 'ky', 4096, okCheck(files.get('y')!));
  assert.ok(!log.some((l) => l.startsWith('s1:')), 'banned source 1 never requested again');
});

test('S-03 a transport failure never bans: the source is demoted until it serves again', async () => {
  const files = new Map([['x', deterministicBytes(100, 33)]]);
  const good = files.get('x')!;
  const log: string[] = [];
  let down = 's1';
  const s1 = source({ files }, { fail: () => down === 's1', onRequest: () => log.push('s1') });
  const s2 = source({ files }, { fail: () => down === 's2', onRequest: () => log.push('s2') });
  const store = storeOf([s1, s2]);
  await store.fetchChecked('x', 'k1', 4096, okCheck(good));
  assert.deepEqual(log, ['s1', 's2']);
  await store.fetchChecked('x', 'k2', 4096, okCheck(good));
  assert.deepEqual(log.slice(2), ['s2'], 'the failed source is tried after the others');
  down = 's2';
  await store.fetchChecked('x', 'k3', 4096, okCheck(good));
  assert.deepEqual(log.slice(3), ['s2', 's1'], 'demoted, not banned: it serves when the others fail');
  await store.fetchChecked('x', 'k4', 4096, okCheck(good));
  assert.deepEqual(log.slice(5), ['s1'], 'serving again restores its place');
  assert.equal(store.stats.rejected, 0);
});

test('S-03b demoted sources go last, least recently failed first; serving restores them, on every fetch path', async () => {
  const buffer = deterministicBytes(200, 42);
  const files = new Map([['x', deterministicBytes(100, 43)]]);
  const run = (offset: number) => [{ offset, length: 50, digest: sha256Hex(buffer.subarray(offset, offset + 50)) }];
  const log: string[] = [];
  let down = new Set(['a', 'b']);
  const make = (name: string) => source({ files, buffer }, { fail: () => down.has(name), onRequest: () => log.push(name) });
  const store = storeOf([make('a'), make('b'), make('c')]);
  const step = async (failing: string[], fetch: () => Promise<unknown>) => {
    down = new Set(failing);
    log.length = 0;
    await fetch();
    return [...log];
  };
  assert.deepEqual(await step(['a', 'b'], () => store.fetchRangeUnverified('map', 0, 50)), ['a', 'b', 'c']);
  assert.deepEqual(await step(['c'], () => store.fetchRun('map', run(50))), ['c', 'a'], 'a, failed before b, comes first');
  assert.deepEqual(await step(['a'], () => store.fetchRangeUnverified('map', 100, 50)), ['a', 'b'], 'a served: back in its place');
  // Listed order would try a next; c failed before a did, so c comes first.
  assert.deepEqual(await step(['b'], () => store.fetchChecked('x', 'kx', 4096, okCheck(files.get('x')!))), ['b', 'c']);
  assert.equal(store.stats.rejected, 0);
});

test('S-04 fetchWhole (digest wrapper) inherits bans', async () => {
  const files = new Map([['x', deterministicBytes(100, 34)], ['y', deterministicBytes(60, 35)]]);
  const log: string[] = [];
  const s1 = source({ files }, { onRequest: (w) => log.push(`s1:${w}`), tamper: (b) => flipByte(b) });
  const s2 = source({ files }, { onRequest: (w) => log.push(`s2:${w}`) });
  const store = storeOf([s1, s2]);
  await store.fetchWhole('x', sha256Hex(files.get('x')!), 4096);
  log.length = 0;
  await store.fetchWhole('y', sha256Hex(files.get('y')!), 4096);
  assert.ok(!log.some((l) => l.startsWith('s1:')));
});

test('S-05 every source banned still throws, never hangs or empties to success', async () => {
  const files = new Map([['x', deterministicBytes(100, 36)]]);
  const good = files.get('x')!;
  const store = storeOf([
    source({ files }, { tamper: (b) => flipByte(b) }),
    source({ files }, { tamper: (b) => flipByte(b, 1) }),
  ]);
  await assert.rejects(store.fetchChecked('x', 'k', 4096, okCheck(good)), AggregateError);
  await assert.rejects(store.fetchChecked('x', 'k2', 4096, okCheck(good)), AggregateError);
});

test('S-06 a banned source is skipped by speculative range reads too', async () => {
  const files = new Map([['x', deterministicBytes(100, 37)]]);
  const good = files.get('x')!;
  const buffer = deterministicBytes(200, 38);
  const log: string[] = [];
  const s1 = source({ files, buffer }, { onRequest: (w) => log.push(`s1:${w}`), tamper: (b) => flipByte(b) });
  const s2 = source({ files, buffer }, { onRequest: (w) => log.push(`s2:${w}`) });
  const store = storeOf([s1, s2]);
  await store.fetchChecked('x', 'k', 4096, okCheck(good)); // bans s1
  log.length = 0;
  await store.fetchRangeUnverified('map', 0, 50);
  assert.ok(!log.some((l) => l.startsWith('s1:')), 'banned source skipped in unverified reads');
});

test('S-07 check runs once per network response and never on a cache hit', async () => {
  const bytes = deterministicBytes(100, 39);
  let checks = 0;
  const check = async (b: Uint8Array) => {
    checks++;
    if (!equalBytes(b, bytes)) throw new VerificationError('bad');
  };
  const store = storeOf([source({ files: new Map([['x', bytes]]) })]);
  await store.fetchChecked('x', 'k', 4096, check);
  await store.fetchChecked('x', 'k', 4096, check); // cache hit
  assert.equal(checks, 1);
});

test('S-08 a non-VerificationError from check is transport: no ban, no rejected', async () => {
  const files = new Map([['x', deterministicBytes(100, 40)], ['y', deterministicBytes(70, 41)]]);
  const good = files.get('x')!;
  const goodY = files.get('y')!;
  const log: string[] = [];
  let s2Down = false;
  const s1 = source({ files }, { onRequest: (w) => log.push(`s1:${w}`), tamper: (b) => flipByte(b) });
  const s2 = source({ files }, { fail: () => s2Down, onRequest: (w) => log.push(`s2:${w}`) });
  const store = storeOf([s1, s2]);
  const plainCheck = (want: Uint8Array) => async (b: Uint8Array) => {
    if (!equalBytes(b, want)) throw new Error('mismatch'); // plain Error, not VerificationError
  };
  await store.fetchChecked('x', 'kx', 4096, plainCheck(good));
  assert.equal(store.stats.rejected, 0);
  log.length = 0;
  s2Down = true;
  await assert.rejects(store.fetchChecked('y', 'ky', 4096, plainCheck(goodY)), AggregateError);
  assert.deepEqual(log, ['s2:whole:y', 's1:whole:y'], 'source 1 demoted, not banned: tried after source 2');
  assert.equal(store.stats.rejected, 0);
});

test("HS-01 fetchCheckedFrom reads a file at its own locations; a ban holds per location across the client's files", async () => {
  const bytesA = deterministicBytes(100, 50);
  const bytesB = deterministicBytes(80, 51);
  const log: string[] = [];
  const served: Record<string, Uint8Array> = { 'https://liar/a': bytesA, 'https://good/a': bytesA, 'https://liar/b': bytesB, 'https://good/b': bytesB };
  const table: Record<string, string[]> = { A: ['https://liar/a', 'https://good/a'], B: ['https://liar/a', 'https://liar/b', 'https://good/b'] };
  const locator = new Locator({ locate: (cid) => table[cid] ?? [] }, noDefaults);
  const store = new VerifiedStore({
    sourceFor: (location) =>
      source({ files: new Map([['', served[location]!]]) }, { onRequest: () => log.push(location), tamper: location.includes('liar') ? (b) => flipByte(b) : undefined }),
  });
  assert.deepEqual(await store.fetchCheckedFrom(locator.for('A', { kind: 'content' }), 'A', 4096, okCheck(bytesA)), bytesA);
  assert.equal(store.stats.rejected, 1);
  log.length = 0;
  assert.deepEqual(await store.fetchCheckedFrom(locator.for('B', { kind: 'content' }), 'B', 4096, okCheck(bytesB)), bytesB);
  assert.deepEqual(log, ['https://liar/b', 'https://good/b'], 'the banned location is skipped; another location on the same host is not');
  await assert.rejects(store.fetchChecked('x', 'k', 4096, okCheck(bytesA)), /per-call locations/);
});

// --- Locations from a router (SPEC §4, §6) ---

const noDefaults: DefaultLocations = { open: () => ({ configured: [], rest: (async function* () {})() }), consulted: () => [] };

// A store over the locations a router yields for one CID, each an in-memory
// host named by `https://{name}`: `down` holds the names failing in
// transport, and every request is logged by name.
function overRouter(
  locate: (urls: (...names: string[]) => string[]) => ReturnType<Router['locate']>,
  { files = new Map(), buffer = new Uint8Array(0) }: { files?: Map<string, Uint8Array>; buffer?: Uint8Array } = {},
) {
  const log: string[] = [];
  const down = new Set<string>();
  const verdicts: Record<string, Verdict[]> = {};
  const urls = (...names: string[]) => names.map((name) => `https://${name}`);
  const locations = new Locator({ locate: () => locate(urls) }, noDefaults).for('bafkfile', { kind: 'content' });
  const store = new VerifiedStore({
    locations,
    sourceFor: (location) => {
      const name = new URL(location).host;
      return source({ files, buffer }, { fail: () => down.has(name), onRequest: () => log.push(name), verdicts: (verdicts[name] = []) });
    },
  });
  return { store, locations, log, down, verdicts, names: () => locations.held().map((url) => new URL(url).host) };
}

const fileX = deterministicBytes(100, 60);
const fileY = deterministicBytes(90, 61);
const xy = new Map([['x', fileX], ['y', fileY]]);

test('ST-01 a fetch asks for a fresh location before going back to a demoted one, which waits for the stream to end', async () => {
  const { store, log, down } = overRouter(async function* (urls) { yield* urls('a', 'b'); }, { files: xy });
  down.add('a');
  assert.deepEqual(await store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), fileX);
  assert.deepEqual(log, ['a', 'b'], 'a failed: b pulled');
  down.clear();
  down.add('b');
  log.length = 0;
  assert.deepEqual(await store.fetchChecked('y', 'ky', 4096, okCheck(fileY)), fileY);
  assert.deepEqual(log, ['b', 'a'], 'b first (a is demoted); b fails, the stream has ended, so a again');
});

test('ST-02 a fetch gives up after 16 failed locations; the next one reads the stream on without asking again', async () => {
  let asked = 0;
  const { store, log, down } = overRouter(
    async function* (urls) {
      asked++;
      for (let i = 0; i < 20; i++) yield* urls(`dead${i}`);
      yield* urls('good');
    },
    { files: xy },
  );
  for (let i = 0; i < 20; i++) down.add(`dead${i}`);
  await assert.rejects(store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), AggregateError);
  assert.equal(log.length, 16);
  log.length = 0;
  assert.deepEqual(await store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), fileX);
  assert.deepEqual(log, ['dead16', 'dead17', 'dead18', 'dead19', 'good']);
  assert.equal(asked, 1);
});

test('ST-03 no location is the locations\' own error; once all failed after the stream ended, the router is asked again', async () => {
  const answers = [[], ['a'], ['a', 'b']];
  let asked = 0;
  const { store, log, down } = overRouter((urls) => urls(...(answers[asked++] ?? [])), { files: xy });
  await assert.rejects(store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), /^Error: no content location for bafkfile; consulted the router$/);
  down.add('a');
  await assert.rejects(store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), AggregateError);
  assert.deepEqual(await store.fetchChecked('x', 'kx', 4096, okCheck(fileX)), fileX);
  assert.deepEqual(log, ['a', 'b'], 'a, known and demoted, waits until the new answer is read');
  assert.equal(asked, 3);
});

test('ST-04 speculation reads the held locations only, never asking for more', async () => {
  const buffer = deterministicBytes(200, 62);
  const { store, locations, log, down, names } = overRouter(async function* (urls) { yield* urls('a', 'b'); }, { buffer });
  await locations.pull();
  down.add('a');
  await assert.rejects(store.fetchRangeUnverified('map', 0, 50), AggregateError);
  assert.deepEqual(log, ['a']);
  assert.deepEqual(names(), ['a']);
});

test('ST-05 the first request goes out synchronously; concurrent fetches share one pull', async () => {
  let release!: () => void;
  let reads = 0;
  const { store, log } = overRouter(
    async function* (urls) {
      reads++;
      await new Promise<void>((resolve) => (release = resolve));
      yield* urls('a');
    },
    { files: xy },
  );
  const x = store.fetchChecked('x', 'kx', 4096, okCheck(fileX));
  const y = store.fetchChecked('y', 'ky', 4096, okCheck(fileY));
  await new Promise(setImmediate);
  assert.equal(reads, 1, 'one read for two fetches');
  release();
  assert.deepEqual(await Promise.all([x, y]), [fileX, fileY]);
  void store.fetchChecked('x', 'kx2', 4096, okCheck(fileX));
  assert.deepEqual(log, ['a', 'a', 'a'], 'with a location held, the request is out before the call returns');
});

test('ST-06 each response is judged: verified, rejected (and banned), failed for a plain check error, unused when aborted', async () => {
  const { store, verdicts, log } = overRouter((urls) => urls('a'), { files: xy });
  await store.fetchChecked('x', 'kx', 4096, okCheck(fileX));
  await assert.rejects(store.fetchChecked('y', 'k1', 4096, async () => { throw new Error('plain'); }), AggregateError);
  const controller = new AbortController();
  const stopping = async () => {
    controller.abort();
    throw new Error('stopped');
  };
  await assert.rejects(store.fetchChecked('y', 'k2', 4096, stopping, { signal: controller.signal }));
  await assert.rejects(store.fetchChecked('y', 'k3', 4096, okCheck(fileX)), AggregateError);
  assert.deepEqual(verdicts.a, ['verified', 'failed', 'unused', 'rejected']);
  log.length = 0;
  await assert.rejects(store.fetchChecked('x', 'k4', 4096, okCheck(fileX)), AggregateError);
  assert.deepEqual(log, [], 'banned for the rest of the session');
});

test('ST-07 readers sharing one speculative body settle it together, after the last one reports', async () => {
  const buffer = deterministicBytes(200, 63);
  const { store, locations, verdicts, log } = overRouter((urls) => urls('a'), { buffer });
  await locations.pull();
  const [first, second] = await Promise.all([store.fetchRangeUnverified('map', 0, 50), store.fetchRangeUnverified('map', 0, 50)]);
  assert.deepEqual(log, ['a'], 'one request');
  first.settle('unused');
  assert.deepEqual(verdicts.a, [], 'one reader is still out');
  second.settle('verified');
  second.settle('rejected');
  assert.deepEqual(verdicts.a, ['verified']);
});

test('S-09 aborting mid-fetchChecked rejects and leaves the store usable', async () => {
  const bytes = deterministicBytes(100, 42);
  const hanging: ByteSource = {
    fetchWhole: (_p, _c, { signal } = {}) =>
      new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    fetchRange: async () => {
      throw new Error('unused');
    },
  };
  const store = storeOf([hanging]);
  const controller = new AbortController();
  const pending = store.fetchChecked('x', 'k', 4096, okCheck(bytes), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);

  const store2 = storeOf([source({ files: new Map([['x', bytes]]) })]);
  assert.deepEqual(await store2.fetchChecked('x', 'k', 4096, okCheck(bytes)), bytes);
});

test('ST-08 wrong bytes ban a location for their CID only: for another it is demoted, still tried last', async () => {
  const fileA = deterministicBytes(100, 64);
  const fileB = deterministicBytes(80, 65);
  const log: string[] = [];
  const served: Record<string, Uint8Array> = { 'https://h/b': fileB, 'https://h/a': fileA };
  const table: Record<string, string[]> = { A: ['https://h/b', 'https://h/a'], B: ['https://h/b'] };
  const locator = new Locator({ locate: (cid) => table[cid] ?? [] }, noDefaults);
  const store = new VerifiedStore({
    sourceFor: (location) => source({ files: new Map([['', served[location]!]]) }, { onRequest: () => log.push(location) }),
  });
  assert.deepEqual(await store.fetchCheckedFrom(locator.for('A', { kind: 'content' }), 'A', 4096, okCheck(fileA)), fileA);
  assert.equal(store.stats.rejected, 1, "b's bytes are not A's");
  assert.deepEqual(await store.fetchCheckedFrom(locator.for('B', { kind: 'content' }), 'B', 4096, okCheck(fileB)), fileB);
  assert.deepEqual(log, ['https://h/b', 'https://h/a', 'https://h/b'], "B's own location still serves B");
});

test("ST-09 a store keeps one source per CID and location, so each request is routed for its own CID", async () => {
  const made: string[] = [];
  const file = deterministicBytes(50, 66);
  const locator = new Locator({ locate: () => ['https://h/same'] }, noDefaults);
  const store = new VerifiedStore({
    sourceFor: (location, cid) => {
      made.push(`${cid} ${location}`);
      return source({ files: new Map([['', file]]) });
    },
  });
  await store.fetchCheckedFrom(locator.for('A', { kind: 'content' }), 'A', 4096, okCheck(file));
  await store.fetchCheckedFrom(locator.for('B', { kind: 'content' }), 'B', 4096, okCheck(file));
  assert.deepEqual(made, ['A https://h/same', 'B https://h/same']);
});

test('ST-10 a host sending over-long ranges is demoted by speculation, so the next one goes elsewhere first', async () => {
  const buffer = deterministicBytes(200, 67);
  const log: string[] = [];
  const longer = source({ buffer }, { onRequest: () => log.push('long'), tamper: (b) => new Uint8Array([...b, 1]) });
  const exact = source({ buffer }, { onRequest: () => log.push('exact') });
  const sized = (s: ByteSource): ByteSource => ({
    fetchWhole: s.fetchWhole,
    // A RangeSource refuses a body longer than asked; this fake does too.
    fetchRange: async (path, start, length, opts) => {
      const body = await s.fetchRange(path, start, length, opts);
      if (body.bytes.length > length) throw new VerificationError('response exceeds expected length');
      return body;
    },
  });
  const store = storeOf([sized(longer), sized(exact)]);
  await store.fetchRangeUnverified('map', 0, 50);
  await store.fetchRangeUnverified('map', 50, 50);
  assert.deepEqual(log, ['long', 'exact', 'exact']);
});
