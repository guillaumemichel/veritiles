// V5 — src/ranged-reader.ts (PLAN §7.T5 F-12). The content-agnostic read loop,
// exercised over a FAKE LeafIndex (not the real proof index): runs, coalescing,
// cache-copy, cold speculation + adopt, misaligned discard, tamper fallback,
// abort recovery, and over-length cutoff — the behaviors the deleted
// map-file.test.ts carried, now proven against the renamed module.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RangedReader, type Leaf, type LeafIndex } from '../packages/anymirror/src/ranged-reader.ts';
import { RangeSource } from '../packages/anymirror/src/range-source.ts';
import type { Router, Verdict } from '../packages/router/src/index.ts';
import { deterministicBytes, flipByte, sha256Hex } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { rangedStoreOf } from './helpers/store.ts';

// A LeafIndex driven by a cut list: cold until leavesFor runs (like a real
// multi-level descent), warm after. Never fetches; leaves come from the cuts.
// `shardsSent` gates the lookup's "shards requested" signal; `signals: false`
// models a lookup that never sends it.
class FakeIndex implements LeafIndex {
  #leaves: Leaf[] = [];
  #resolved = false;
  #shardsSent: Promise<void>;
  #signals: boolean;
  constructor(data: Uint8Array, cuts: number[], { shardsSent = Promise.resolve(), signals = true } = {}) {
    this.#shardsSent = shardsSent;
    this.#signals = signals;
    let offset = 0;
    for (const length of cuts) {
      this.#leaves.push({ offset, length, digest: sha256Hex(data.subarray(offset, offset + length)) });
      offset += length;
    }
  }
  #covering(start: number, end: number): Leaf[] {
    return this.#leaves.filter((l) => l.offset + l.length > start && l.offset < end);
  }
  async leavesFor(start: number, end: number, { onShardsRequested }: { onShardsRequested?: () => void } = {}): Promise<Leaf[]> {
    await this.#shardsSent;
    if (this.#signals) onShardsRequested?.();
    this.#resolved = true;
    return this.#covering(start, end);
  }
  cachedLeavesFor(start: number, end: number): Leaf[] | null {
    return this.#resolved ? this.#covering(start, end) : null;
  }
}

const PATH = 'map.bin';

function open(data: Uint8Array, cuts: number[], opts: HostOptions = {}, index: LeafIndex = new FakeIndex(data, cuts)) {
  const store = rangedStoreOf([new RangeSource('.', { fetchFn: rangeFetch(new Map([[PATH, data]]), opts) })]);
  return { reader: new RangedReader(store, index, PATH, data.length), store };
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

test('a cold read speculates only once the lookup has sent its shard requests', async () => {
  const data = deterministicBytes(3000, 33);
  const ranged: string[] = [];
  let sendShards!: () => void;
  const index = new FakeIndex(data, [100, 900, 2000], { shardsSent: new Promise((resolve) => (sendShards = resolve)) });
  const { reader } = open(data, [100, 900, 2000], { onRequest: (_, h) => h?.Range && ranged.push(h.Range) }, index);
  const read = reader.read(100, 900);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ranged, [], 'no content request ahead of the shards');
  sendShards();
  assert.deepEqual(await read, new Uint8Array(data.subarray(100, 1000)));
  assert.deepEqual(ranged, ['bytes=100-999'], 'one speculative request, adopted');
});

test('a lookup that never signals gets no speculation', async () => {
  const data = deterministicBytes(3000, 34);
  const ranged: string[] = [];
  const index = new FakeIndex(data, [100, 900, 2000], { signals: false });
  const { reader } = open(data, [100, 900, 2000], { onRequest: (_, h) => h?.Range && ranged.push(h.Range) }, index);
  assert.deepEqual(await reader.read(0, 150), new Uint8Array(data.subarray(0, 150)));
  assert.deepEqual(ranged, ['bytes=0-999'], 'only the verified run');
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

// --- Verdicts (SPEC §6): what each read made of its speculative body ---

// A reader whose requests a router carries, logging each range with its verdict.
function openRouted(data: Uint8Array, cuts: number[], opts: HostOptions = {}) {
  const log: { range: string; verdict: Promise<Verdict> }[] = [];
  const router: Router = {
    locate: () => [],
    fetch: (url, init, context) => {
      log.push({ range: new Headers(init.headers).get('Range') ?? 'whole', verdict: context.verdict });
      return context.next(url, init);
    },
  };
  const source = new RangeSource('.', { fetchFn: rangeFetch(new Map([[PATH, data]]), opts), route: { router, cid: 'bafkmap', location: '.' } });
  const reader = new RangedReader(rangedStoreOf([source]), new FakeIndex(data, cuts), PATH, data.length);
  const verdicts = async () => Promise.all(log.map(async ({ range, verdict }) => `${range} ${await verdict}`));
  return { reader, verdicts };
}

test('RR-V1: an adopted speculative body is verified; so is a warm read\'s run', async () => {
  const data = deterministicBytes(3000, 33);
  const { reader, verdicts } = openRouted(data, [100, 900, 2000]);
  await reader.read(100, 900);
  await reader.read(1000, 2000);
  assert.deepEqual(await verdicts(), ['bytes=100-999 verified', 'bytes=1000-2999 verified']);
});

test('RR-V2: a speculative body the read cannot use is unused; a tampered one is rejected', async () => {
  const data = deterministicBytes(3000, 34);
  const misaligned = openRouted(data, [100, 900, 2000]);
  await misaligned.reader.read(0, 150);
  assert.deepEqual((await misaligned.verdicts()).sort(), ['bytes=0-149 unused', 'bytes=0-999 verified']);

  let calls = 0;
  const tampered = openRouted(data, [100, 900, 2000], {
    tamper: (path, range, bytes) => (path === PATH && range && ++calls === 1 ? flipByte(bytes) : bytes),
  });
  await tampered.reader.read(100, 900);
  assert.deepEqual(await tampered.verdicts(), ['bytes=100-999 rejected', 'bytes=100-999 verified']);
});
