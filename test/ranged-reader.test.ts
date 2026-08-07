// V5 — src/ranged-reader.ts (PLAN §7.T5 F-12). The content-agnostic read loop,
// exercised over a FAKE LeafIndex (not the real proof index): runs, coalescing,
// cache-copy, cold speculation + adopt, misaligned discard, tamper fallback,
// abort recovery, and over-length cutoff — the behaviors the deleted
// map-file.test.ts carried, now proven against the renamed module.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RangedReader, type Leaf, type LeafIndex } from '../src/ranged-reader.ts';
import { RangeSource } from '../src/range-source.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte, sha256Hex } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';

// A LeafIndex driven by a cut list: cold until leavesFor runs (like a real
// multi-level descent), warm after. Never fetches; leaves come from the cuts.
class FakeIndex implements LeafIndex {
  #leaves: Leaf[] = [];
  #resolved = false;
  constructor(data: Uint8Array, cuts: number[]) {
    let offset = 0;
    for (const length of cuts) {
      this.#leaves.push({ offset, length, digest: sha256Hex(data.subarray(offset, offset + length)) });
      offset += length;
    }
  }
  #covering(start: number, end: number): Leaf[] {
    return this.#leaves.filter((l) => l.offset + l.length > start && l.offset < end);
  }
  async leavesFor(start: number, end: number): Promise<Leaf[]> {
    this.#resolved = true;
    return this.#covering(start, end);
  }
  cachedLeavesFor(start: number, end: number): Leaf[] | null {
    return this.#resolved ? this.#covering(start, end) : null;
  }
}

const PATH = 'map.bin';

function open(data: Uint8Array, cuts: number[], opts: HostOptions = {}) {
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(new Map([[PATH, data]]), opts) })]);
  return { reader: new RangedReader(store, new FakeIndex(data, cuts), PATH, data.length), store };
}

const readsAgree = async (reader: RangedReader, data: Uint8Array) => {
  for (const [offset, length] of [
    [0, data.length],
    [0, 17],
    [data.length - 13, 13],
    [491, 512],
    [500, 1],
    [data.length - 5, 100],
  ] as const) {
    const got = await reader.read(offset, length);
    const want = data.subarray(offset, Math.min(offset + length, data.length));
    assert.deepEqual(got, new Uint8Array(want), `read(${offset}, ${length})`);
  }
};

test('reads agree with the source across leaves', async () => {
  const data = deterministicBytes(5000, 20);
  const { reader } = open(data, [100, 900, 2000, 1500, 500]);
  assert.equal(reader.size, data.length);
  await readsAgree(reader, data);
});

test('a multi-leaf read coalesces into one range request', async () => {
  const data = deterministicBytes(5000, 23);
  let ranged = 0;
  const { reader } = open(data, [100, 900, 2000, 1500, 500], { onRequest: (_, h) => h?.Range && ranged++ });
  await reader.read(0, data.length);
  assert.equal(ranged, 1);
});

test('a cache hit splits a run', async () => {
  const data = deterministicBytes(3000, 24);
  const ranged: string[] = [];
  const { reader } = open(data, [100, 900, 2000], { onRequest: (_, h) => h?.Range && ranged.push(h.Range) });
  await reader.read(100, 900); // caches leaf [100,1000)
  ranged.length = 0;
  await reader.read(0, 3000);
  assert.deepEqual(ranged.sort(), ['bytes=0-99', 'bytes=1000-2999']);
});

test('a cold leaf-aligned read races the tile fetch against the descent', async () => {
  const data = deterministicBytes(3000, 29);
  const ranged: string[] = [];
  const { reader } = open(data, [100, 900, 2000], { onRequest: (_, h) => h?.Range && ranged.push(h.Range) });
  assert.deepEqual(await reader.read(100, 900), new Uint8Array(data.subarray(100, 1000)));
  assert.deepEqual(ranged, ['bytes=100-999'], 'served by the one speculative request');
  ranged.length = 0;
  await reader.read(100, 900);
  assert.deepEqual(ranged, [], 'warm repeat: no request');
});

test('a misaligned cold read discards the speculation and fetches the run', async () => {
  const data = deterministicBytes(3000, 31);
  const ranged: string[] = [];
  const { reader } = open(data, [100, 900, 2000], { onRequest: (_, h) => h?.Range && ranged.push(h.Range) });
  assert.deepEqual(await reader.read(0, 150), new Uint8Array(data.subarray(0, 150)));
  assert.deepEqual(ranged.sort(), ['bytes=0-149', 'bytes=0-999']);
});

test('a tampered speculative body falls back to a verified fetch', async () => {
  const data = deterministicBytes(3000, 32);
  let calls = 0;
  const { reader, store } = open(data, [100, 900, 2000], {
    tamper: (path, range, bytes) => (path === PATH && range && ++calls === 1 ? flipByte(bytes) : bytes),
  });
  assert.deepEqual(await reader.read(100, 900), new Uint8Array(data.subarray(100, 1000)));
  assert.equal(calls, 2, 'speculation rejected, verified run fetched');
  assert.equal(store.stats.rejected, 1);
});

test('out-of-range reads return empty', async () => {
  const data = deterministicBytes(300, 25);
  const { reader } = open(data, [100, 200]);
  assert.equal((await reader.read(300, 10)).length, 0);
  assert.equal((await reader.read(-5, 3)).length, 0);
});

test('a corrupted leaf in a range response is rejected', async () => {
  const data = deterministicBytes(5000, 26);
  const { reader } = open(data, [100, 900, 2000, 1500, 500], {
    tamper: (path, range, bytes) => (path === PATH && range ? flipByte(bytes) : bytes),
  });
  await assert.rejects(reader.read(0, data.length), AggregateError);
});

test('an aborted read does not poison later reads', async () => {
  const data = deterministicBytes(3000, 28);
  const { reader } = open(data, [100, 900, 2000]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.read(0, 3000, { signal: controller.signal }));
  assert.deepEqual(await reader.read(0, 3000), new Uint8Array(data));
});

test('a range response longer than the run is cut off before hashing', async () => {
  const data = deterministicBytes(1000, 27);
  const { reader } = open(data, [400, 600], {
    tamper: (path, range, bytes) => (path === PATH && range ? new Uint8Array([...bytes, 1, 2, 3]) : bytes),
  });
  await assert.rejects(reader.read(0, 400), (err: AggregateError) => {
    assert.match((err.errors[0] as Error).message, /exceeds expected length/);
    return true;
  });
});
