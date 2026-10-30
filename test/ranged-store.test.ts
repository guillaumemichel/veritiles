// Byte runs and speculative ranges: a run's leaves verify together before
// any is cached; a speculative body is read unverified, shared by its
// readers, and adopted leaf by leaf.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type RangedByteSource, RangedStore } from '../src/ranged-store.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes, flipByte, sha256Hex } from './helpers/bytes.ts';
import { memorySource as source, okCheck, rangedStoreOf as storeOf, routedHosts } from './helpers/store.ts';

// A ranged store over the locations a router yields for one CID.
function overRouter(...args: Parameters<typeof routedHosts>) {
  const hosts = routedHosts(...args);
  return { ...hosts, store: new RangedStore(hosts) };
}

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

test('ST-04 speculation reads the held locations only, never asking for more', async () => {
  const buffer = deterministicBytes(200, 62);
  const { store, locations, log, down, names } = overRouter(async function* (urls) { yield* urls('a', 'b'); }, { buffer });
  await locations.pull();
  down.add('a');
  await assert.rejects(store.fetchRangeUnverified('map', 0, 50), AggregateError);
  assert.deepEqual(log, ['a']);
  assert.deepEqual(names(), ['a']);
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

test('ST-10 a host sending over-long ranges is demoted by speculation, so the next one goes elsewhere first', async () => {
  const buffer = deterministicBytes(200, 67);
  const log: string[] = [];
  const longer = source({ buffer }, { onRequest: () => log.push('long'), tamper: (b) => new Uint8Array([...b, 1]) });
  const exact = source({ buffer }, { onRequest: () => log.push('exact') });
  const sized = (s: RangedByteSource): RangedByteSource => ({
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
