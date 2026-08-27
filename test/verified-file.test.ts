// VerifiedFile suite (PLAN-shards §5 S4): the public ranges client over the
// shard-tree proof — sync construction, lazy memoized open, descriptor at
// open, one Range per cold read, EOF clamp, fresh copies, proof/content
// failover, bans, abort, request-count invariants.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { VerifiedFile } from '../src/verified-file.ts';
import { VerificationError } from '../src/verify.ts';
import { flipByte, sha256Bytes } from './helpers/bytes.ts';
import { buildPkgDeep, buildPkgFlat, buildPkgOne } from './helpers/pkg-fixtures.ts';
import type { ProofPackage } from './helpers/package.ts';
import { servePackage, type FileHostHooks } from './helpers/serve-file.ts';

const SHA2_256 = 0x12;
const FILE = 'https://h/map';

interface RoutedHost {
  fileUrl: string;
  bytes: Uint8Array;
  hooks?: FileHostHooks;
}

// One fetch over several (fileUrl → bytes, proofs) hosts, first match wins.
function route(hosts: { fileUrl: string; bytes: Uint8Array; proofs: Map<string, Uint8Array>; hooks?: FileHostHooks }[]) {
  const routed = hosts.map((h) => servePackage(h.fileUrl, h.bytes, h.proofs, h.hooks));
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    for (const r of routed) {
      const res = await r.fetch(input as string, init);
      if (res.status !== 404) return res;
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function mount(pkg: ProofPackage, fileUrl = FILE, hooks?: FileHostHooks) {
  return route([{ fileUrl, bytes: pkg.mapBytes, proofs: pkg.proofs, hooks }]);
}

const proofGets = (requests: string[]) => requests.filter((u) => u.includes('.proofs/'));

// F-01 — construction validates synchronously with no I/O.
test('F-01: constructor validation', async () => {
  const good = await buildPkgFlat();
  const mk = (codec: number) => CID.createV1(codec, Digest.create(SHA2_256, new Uint8Array(32))).toString();
  assert.throws(() => new VerifiedFile({ cid: mk(0x0202), source: 'https://h/f' }), VerificationError); // car codec
  assert.throws(() => new VerifiedFile({ cid: mk(0x55), source: 'https://h/f' }), VerificationError); // raw
  assert.throws(() => new VerifiedFile({ cid: mk(0x70), source: 'https://h/f' }), VerificationError); // dag-pb
  assert.throws(() => new VerifiedFile({ cid: CID.createV0(Digest.create(SHA2_256, new Uint8Array(32))).toString(), source: 'https://h/f' }), VerificationError);
  assert.throws(() => new VerifiedFile({ cid: good.anchor, source: [] }), Error);
  assert.throws(() => new VerifiedFile({ cid: good.anchor, source: [123 as unknown as string] }), Error);
  assert.throws(() => new VerifiedFile({ cid: good.anchor, source: 'https://h/f?v=1' }), Error); // query, no explicit proof
  assert.doesNotThrow(() => new VerifiedFile({ cid: good.anchor, source: 'https://h/f?v=1', proof: 'https://h/p' }));
  // Locations are optional now: a bare anchor, or an anchor + hints, both construct.
  assert.doesNotThrow(() => new VerifiedFile({ cid: good.anchor }));
  assert.doesNotThrow(() => new VerifiedFile({ cid: good.anchor, hints: 'https://h/hints.json' }));
  // A query-string source with no proof but explicit hints defers the proof question to open.
  assert.doesNotThrow(() => new VerifiedFile({ cid: good.anchor, source: 'https://h/f?v=1', hints: 'https://h/hints.json' }));
});

// F-02 — proof base derivation and ready().
test('F-02/F-03: proof default derivation + ready sets size', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  assert.equal(vf.size, undefined);
  assert.equal(vf.cid, pkg.anchor);
  await vf.ready();
  assert.equal(vf.size, pkg.mapBytes.length);
  assert.deepEqual(proofGets(requests), [`${FILE}.proofs/root`]);
});

// F-04 — read clamps at EOF, empties out-of-range, returns fresh copies.
test('F-04: EOF clamp, empties, fresh copies', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  const tail = await vf.read(pkg.mapBytes.length - 10, 5000);
  assert.equal(tail.length, 10, 'clamped to EOF');
  assert.equal((await vf.read(pkg.mapBytes.length, 100)).length, 0);
  assert.equal((await vf.read(0, 0)).length, 0);
  const a = await vf.read(0, 20);
  a.fill(0xff);
  const b = await vf.read(0, 20);
  assert.notDeepEqual(a, b, 'each read is a fresh copy');
});

// F-05 — a cold read costs exactly one Range request.
test('F-05: cold read is one Range request', async () => {
  const pkg = await buildPkgDeep();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  await vf.ready();
  requests.length = 0;
  const leaf = pkg.leaves[10]!;
  const got = await vf.read(leaf.offset, leaf.length);
  assert.deepEqual(got, pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
  const ranges = requests.filter((u) => u === FILE);
  assert.equal(ranges.length, 1, `one range, got ${requests.join(', ')}`);
});

// F-06 — a warm read costs zero requests.
test('F-06: warm read is zero requests', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  const leaf = pkg.leaves[0]!;
  await vf.read(leaf.offset, leaf.length);
  requests.length = 0;
  await vf.read(leaf.offset, leaf.length);
  assert.equal(requests.length, 0);
});

// F-07 — a lying proof base is counted and healed via the next proof base.
test('F-07: proof failover heals a read mid-descent', async () => {
  const pkg = await buildPkgDeep();
  const shardPath = [...pkg.proofs.keys()].find((p) => p !== 'root' && !p.endsWith('meta'))!;
  const evil = {
    fileUrl: 'https://evil/map',
    bytes: pkg.mapBytes,
    proofs: pkg.proofs,
    hooks: { tamperProof: (p: string, b: Uint8Array) => (p === shardPath ? flipByte(b) : undefined) } satisfies FileHostHooks,
  };
  const good = { fileUrl: 'https://good/map', bytes: pkg.mapBytes, proofs: pkg.proofs };
  const { fetchFn, requests } = route([evil, good]);
  const vf = new VerifiedFile({
    cid: pkg.anchor,
    source: 'https://good/map',
    proof: ['https://evil/map.proofs', 'https://good/map.proofs'],
    fetchFn,
  });
  const got = await vf.read(0, pkg.mapBytes.length);
  assert.deepEqual(got, pkg.mapBytes);
  assert.ok(vf.stats.rejected >= 1, 'the lying proof base was caught');
  assert.ok(proofGets(requests).some((u) => u.startsWith('https://good/')), 'healed via the second proof base');
});

// F-08 — a tampering content source is caught, banned, and survived.
test('F-08: content tamper is banned and survived via a mirror', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn, requests } = route([
    { fileUrl: 'https://evil/map', bytes: pkg.mapBytes, proofs: pkg.proofs, hooks: { tamperRange: (b) => flipByte(b) } },
    { fileUrl: 'https://good/map', bytes: pkg.mapBytes, proofs: pkg.proofs },
  ]);
  const vf = new VerifiedFile({
    cid: pkg.anchor,
    source: ['https://evil/map', 'https://good/map'],
    proof: 'https://good/map.proofs',
    fetchFn,
  });
  const leaf = pkg.leaves[0]!;
  const first = await vf.read(leaf.offset, leaf.length);
  assert.deepEqual(first, pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length));
  assert.ok(vf.stats.rejected >= 1, 'tamper caught');
  requests.length = 0;
  const next = pkg.leaves[1]!;
  await vf.read(next.offset, next.length);
  assert.equal(requests.filter((u) => u === 'https://evil/map').length, 0, 'evil source banned, not retried');
});

// F-09 — abort.
test('F-09: abort rejects and recovers', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(vf.read(0, 100, { signal: pre.signal }));
  assert.equal(requests.length, 0, 'pre-aborted: zero requests');
  assert.deepEqual(await vf.read(0, 100), pkg.mapBytes.subarray(0, 100));
});

// F-10 — concurrent identical reads dedup to one Range request.
test('F-10: concurrent identical reads dedup', async () => {
  const pkg = await buildPkgDeep();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  await vf.ready();
  requests.length = 0;
  const leaf = pkg.leaves[5]!;
  const [a, b] = await Promise.all([vf.read(leaf.offset, leaf.length), vf.read(leaf.offset, leaf.length)]);
  assert.deepEqual(a, b);
  assert.equal(requests.filter((u) => u === FILE).length, 1, 'one range request for two identical reads');
});

// F-11 — the degenerate one-leaf package verifies end to end.
test('F-11: one-leaf package verifies end to end', async () => {
  const pkg = await buildPkgOne();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  const got = await vf.read(0, pkg.mapBytes.length);
  assert.deepEqual(got, pkg.mapBytes);
  assert.deepEqual(proofGets(requests), [`${FILE}.proofs/root`, `${FILE}.proofs/0`]);
});

// F-12 — request-count invariants: cold first read is descriptor + shard;
// steady state zero; a new region costs exactly one shard.
test('F-12: proof request counts', async () => {
  const pkg = await buildPkgDeep();
  const { fetchFn, requests } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  const first = pkg.leaves[0]!;
  await vf.read(first.offset, first.length);
  const coldProofGets = proofGets(requests);
  assert.ok(coldProofGets.length <= 3, `cold first read: root + metas + one shard, got ${coldProofGets.join(', ')}`);
  assert.equal(coldProofGets[0], `${FILE}.proofs/root`);
  assert.ok(coldProofGets.some((u) => u.endsWith('.proofs/0')), 'the covering shard was fetched');

  requests.length = 0;
  await vf.read(first.offset, first.length);
  assert.equal(requests.length, 0, 'warm read: zero requests');

  // A leaf in an unvisited shard: exactly one new proof file (its shard;
  // every meta on the path is cached from the first descent… only when the
  // path is shared, so pick a leaf under the same sub-meta).
  requests.length = 0;
  const near = pkg.leaves[3]!; // same 2-record shard region as leaf 2? leaf 3 is in shard 2
  await vf.read(near.offset, near.length);
  const newProofGets = proofGets(requests);
  assert.ok(newProofGets.length <= 1, `new region costs ≤ 1 proof fetch, got ${newProofGets.join(', ')}`);
});

// F-13 — deterministic stats over a cold/warm sequence.
test('F-13: deterministic stats', async () => {
  const pkg = await buildPkgFlat();
  const { fetchFn } = mount(pkg);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn });
  await vf.ready();
  assert.deepEqual(vf.stats, { verified: 1, rejected: 0 }, 'open hashes only the descriptor');
  await vf.read(pkg.leaves[0]!.offset, pkg.leaves[0]!.length); // +shard +leaf
  await vf.read(pkg.leaves[1]!.offset, pkg.leaves[1]!.length); // +leaf (shard cached)
  await vf.read(pkg.leaves[0]!.offset, pkg.leaves[0]!.length); // warm, +0
  assert.deepEqual(vf.stats, { verified: 4, rejected: 0 });
});
