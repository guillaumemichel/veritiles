import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MapFile } from '../src/map-file.ts';
import { ProofIndex } from '../src/proof-index.ts';
import { RangeSource } from '../src/range-source.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { buildMapPackage, type BuildOptions } from './helpers/package.ts';

// The full verified read stack over an in-memory dumb host: proofs descent
// → runs → Range requests → digest checks.
async function openFixture(
  data: Uint8Array,
  cuts: number[],
  { tamper, onRequest, ...buildOpts }: HostOptions & Partial<BuildOptions> = {},
) {
  const fixture = await buildMapPackage({ mapBytes: data, cuts, ...buildOpts });
  const store = new VerifiedStore([
    new RangeSource('.', { fetchFn: rangeFetch(fixture.files, { tamper, onRequest }) }),
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(fixture.files.get('metadata.json')!));
  const proofs = new ProofIndex(store, {
    dir: 'proofs',
    metaDigest: manifest.proofs.metaDigest,
    fileSize: manifest.map.size,
  });
  return { file: new MapFile(store, proofs, 'map.pmtiles', data.length), fixture, store };
}

const readsAgree = async (file: MapFile, data: Uint8Array) => {
  for (const [offset, length] of [
    [0, data.length], // whole file
    [0, 17], // head
    [data.length - 13, 13], // tail
    [491, 512], // straddles several leaves
    [500, 1], // single byte
    [data.length - 5, 100], // clamped past EOF
  ] as const) {
    const got = await file.read(offset, length);
    const want = data.subarray(offset, Math.min(offset + length, data.length));
    assert.deepEqual(got, new Uint8Array(want), `read(${offset}, ${length})`);
  }
};

test('reads agree with the source across tile-aligned leaves', async () => {
  const data = deterministicBytes(5000, 20);
  const { file } = await openFixture(data, [100, 900, 2000, 1500, 500]);
  assert.equal(file.size, data.length);
  await readsAgree(file, data);
});

test('reads agree through a nested proofs tree', async () => {
  const data = deterministicBytes(4000, 21);
  const { file } = await openFixture(
    data,
    Array.from({ length: 40 }, () => 100),
    { shardCap: 40, metaMaxEntries: 4 },
  );
  await readsAgree(file, data);
});

test('a multi-leaf read coalesces into one range request', async () => {
  const data = deterministicBytes(5000, 23);
  let ranged = 0;
  const { file } = await openFixture(data, [100, 900, 2000, 1500, 500], {
    onRequest: (_, h) => h?.Range && ranged++,
  });
  await file.read(0, data.length); // spans all five leaves
  assert.equal(ranged, 1);
});

test('a cache hit splits a run', async () => {
  const data = deterministicBytes(3000, 24);
  const ranged: string[] = [];
  const { file } = await openFixture(data, [100, 900, 2000], {
    onRequest: (_, h) => h?.Range && ranged.push(h.Range),
  });
  await file.read(100, 900); // leaf 1 [100,1000) → caches it
  ranged.length = 0;
  await file.read(0, 3000); // leaf 1 cached ⇒ two runs around it
  assert.deepEqual(ranged.sort(), ['bytes=0-99', 'bytes=1000-2999']);
});

test('a cold leaf-aligned read races the tile fetch against the proof descent', async () => {
  const data = deterministicBytes(3000, 29);
  const log: string[] = [];
  const { file } = await openFixture(data, [100, 900, 2000], {
    onRequest: (url, h) =>
      log.push(h?.Range ? `range:${h.Range}` : url.replace(/^.*proofs/, 'proofs')),
  });
  // Tile-shaped read: exactly leaf 1 [100, 1000).
  assert.deepEqual(await file.read(100, 900), new Uint8Array(data.subarray(100, 1000)));

  const ranged = log.filter((l) => l.startsWith('range:'));
  assert.deepEqual(ranged, ['range:bytes=100-999'], 'served by the one speculative request');
  // The speculation left before any proof file was requested.
  assert.ok(log[0]!.startsWith('range:'), `speculative fetch first, got: ${log.join(', ')}`);
  assert.ok(
    log.some((l) => l.startsWith('proofs')),
    'proof descent ran in parallel',
  );

  // The adopted leaf is cached: a repeat read is fully warm.
  log.length = 0;
  await file.read(100, 900);
  assert.deepEqual(log, []);
});

test('a misaligned cold read discards the speculation and fetches the run', async () => {
  const data = deterministicBytes(3000, 31);
  const ranged: string[] = [];
  const { file } = await openFixture(data, [100, 900, 2000], {
    onRequest: (_, h) => h?.Range && ranged.push(h.Range),
  });
  // [0, 150) covers leaf 0 fully but cuts into leaf 1: not adoptable.
  assert.deepEqual(await file.read(0, 150), new Uint8Array(data.subarray(0, 150)));
  assert.deepEqual(ranged.sort(), ['bytes=0-149', 'bytes=0-999']);
});

test('a tampered speculative body falls back to a verified fetch', async () => {
  const data = deterministicBytes(3000, 32);
  let rangedCalls = 0;
  const { file, store } = await openFixture(data, [100, 900, 2000], {
    tamper: (path, range, bytes) =>
      path === 'map.pmtiles' && range && ++rangedCalls === 1 ? flipByte(bytes) : bytes,
  });
  assert.deepEqual(await file.read(100, 900), new Uint8Array(data.subarray(100, 1000)));
  assert.equal(rangedCalls, 2, 'speculation rejected, verified run fetched');
  assert.equal(store.stats.rejected, 1);
});

test('out-of-range reads return empty', async () => {
  const data = deterministicBytes(300, 25);
  const { file } = await openFixture(data, [100, 200]);
  assert.equal((await file.read(300, 10)).length, 0);
  assert.equal((await file.read(-5, 3)).length, 0);
});

test('a corrupted leaf in a range response is rejected', async () => {
  const data = deterministicBytes(5000, 26);
  const { file } = await openFixture(data, [100, 900, 2000, 1500, 500], {
    tamper: (path, range, bytes) => (path === 'map.pmtiles' && range ? flipByte(bytes) : bytes),
  });
  await assert.rejects(file.read(0, data.length), AggregateError);
});

test('an aborted read does not poison later reads', async () => {
  // MapLibre aborts constantly on pan/zoom; nothing cached from an aborted
  // read may break subsequent reads.
  const data = deterministicBytes(3000, 28);
  const { file } = await openFixture(data, [100, 900, 2000]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(file.read(0, 3000, { signal: controller.signal }));
  assert.deepEqual(await file.read(0, 3000), new Uint8Array(data)); // recovered
});

test('a range response longer than the run is cut off before hashing', async () => {
  const data = deterministicBytes(1000, 27);
  const { file } = await openFixture(data, [400, 600], {
    tamper: (path, range, bytes) =>
      path === 'map.pmtiles' && range ? new Uint8Array([...bytes, 1, 2, 3]) : bytes,
  });
  await assert.rejects(file.read(0, 400), (err: AggregateError) => {
    assert.match((err.errors[0] as Error).message, /exceeds expected length/);
    return true;
  });
});
