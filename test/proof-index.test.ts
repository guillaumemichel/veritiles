import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeDescriptor } from '../src/descriptor.ts';
import { KIND_SHARD } from '../src/proof-format.ts';
import { ProofIndex } from '../src/proof-index.ts';
import { RangeSource } from '../src/range-source.ts';
import { toHex } from '../src/verify.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte, sha256Bytes } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { buildProofPackage, type ProofPackage } from './helpers/package.ts';
import { encodeMeta, encodeShard } from '../src/proof-format.ts';

const mapBytes = deterministicBytes(4000, 40);
const cuts = [100, 900, 2000, 500, 500];

function indexOver(fixture: ProofPackage, opts: HostOptions = {}) {
  const store = new VerifiedStore([
    new RangeSource('.', { fetchFn: rangeFetch(fixture.proofs, opts) }),
  ]);
  const index = new ProofIndex(store, {
    topMeta: decodeDescriptor(fixture.descriptor).topMeta,
    fileSize: fixture.mapBytes.length,
  });
  return { index, store };
}

const asHex = (leaves: ProofPackage['leaves']) =>
  leaves.map((l) => ({ offset: l.offset, length: l.length, digest: toHex(l.digest) }));

test('full-range descent recovers every leaf digest', async () => {
  const fixture = await buildProofPackage({ mapBytes, cuts });
  const { index } = indexOver(fixture);
  assert.deepEqual(await index.leavesFor(0, 4000), asHex(fixture.leaves));
});

test('sub-range descent returns exactly the covering leaves', async () => {
  const fixture = await buildProofPackage({ mapBytes, cuts });
  const { index } = indexOver(fixture);
  const all = asHex(fixture.leaves);
  assert.deepEqual(await index.leavesFor(0, 1), all.slice(0, 1));
  assert.deepEqual(await index.leavesFor(99, 101), all.slice(0, 2)); // straddles a boundary
  assert.deepEqual(await index.leavesFor(100, 1000), all.slice(1, 2)); // exact leaf
  assert.deepEqual(await index.leavesFor(3999, 4000), all.slice(-1));
});

test('a nested tree descends lazily: only covering shards are fetched', async () => {
  // Tiny caps force one leaf per shard and nesting: 40 leaves, fanout 4.
  const lengths = Array.from({ length: 40 }, () => 100);
  const fixture = await buildProofPackage({
    mapBytes: deterministicBytes(4000, 41),
    cuts: lengths,
    shardCap: 40,
    metaMaxEntries: 4,
  });
  const proofRequests: string[] = [];
  const { index } = indexOver(fixture, {
    onRequest: (url) => url !== 'root' && proofRequests.push(url),
  });

  // A tail read must not fetch any head shard file.
  const tail = await index.leavesFor(3900, 4000);
  assert.equal(tail.length, 1);
  assert.deepEqual(tail, asHex(fixture.leaves).slice(-1));
  const headShard = '0';
  assert.ok(
    !proofRequests.some((u) => u === headShard || u.endsWith(`/${headShard}`)),
    `tail read fetched head shard: ${proofRequests.join(', ')}`,
  );
  assert.ok(proofRequests.length >= 2, 'descends through nested metas');

  // The head read touches the head shard only (the top meta is embedded).
  proofRequests.length = 0;
  await index.leavesFor(0, 100);
  assert.ok(proofRequests.some((u) => u === headShard || u.endsWith(`/${headShard}`)));
});

test('a tampered shard is rejected', async () => {
  const fixture = await buildProofPackage({ mapBytes, cuts });
  const shardPath = [...fixture.proofs.keys()].find((p) => p !== 'root' && !p.endsWith('meta'))!;
  const proofs = new Map(fixture.proofs);
  proofs.set(shardPath, flipByte(proofs.get(shardPath)!));
  const { index } = indexOver({ ...fixture, proofs });
  await assert.rejects(index.leavesFor(0, 4000), AggregateError);
});

test('repeat reads are served from the cached shard buffer: no second fetch', async () => {
  const fixture = await buildProofPackage({ mapBytes, cuts });
  const proofRequests: string[] = [];
  const { index } = indexOver(fixture, {
    onRequest: (url) => proofRequests.push(url),
  });
  const first = await index.leavesFor(0, 4000);
  const fetched = proofRequests.length;
  assert.deepEqual(await index.leavesFor(0, 4000), first);
  assert.equal(proofRequests.length, fetched, 'repeat read fetches no proof files');
});

test('cachedLeavesFor answers synchronously once proofs are cached, null before', async () => {
  const fixture = await buildProofPackage({ mapBytes, cuts });
  const { index } = indexOver(fixture);
  assert.equal(index.cachedLeavesFor(0, 4000), null); // cold: needs the network
  const fetched = await index.leavesFor(0, 4000);
  assert.deepEqual(index.cachedLeavesFor(0, 4000), fetched);
  assert.deepEqual(index.cachedLeavesFor(99, 101), fetched.slice(0, 2));
});

test('a shard inconsistent with its meta entry is rejected', async () => {
  // Valid digests all the way down, but the last record starts at byte 60
  // of a 50-byte committed span — an inconsistent build fails closed.
  const shard = encodeShard(
    [
      { offset: 0, digest: deterministicBytes(32, 9) },
      { offset: 60, digest: deterministicBytes(32, 10) },
    ],
    0,
  );
  const meta = encodeMeta([{ kind: KIND_SHARD, length: 50, digest: sha256Bytes(shard) }]);
  const store = new VerifiedStore([
    new RangeSource('.', { fetchFn: rangeFetch(new Map([['0', shard]])) }),
  ]);
  const index = new ProofIndex(store, { topMeta: meta, fileSize: 50 });
  await assert.rejects(index.leavesFor(0, 50), /outside the 50-byte span/);
});

test('a meta whose coverage disagrees with its parent is rejected', async () => {
  // Valid digest, wrong coverage: a hand-built meta covering 50 bytes offered
  // for a 100-byte file — catches an inconsistent build or swapped files.
  const shard = deterministicBytes(35, 42);
  const meta = encodeMeta([{ kind: KIND_SHARD, length: 50, digest: sha256Bytes(shard) }]);
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(new Map()) })]);
  const index = new ProofIndex(store, { topMeta: meta, fileSize: 100 });
  await assert.rejects(index.leavesFor(0, 100), /covers 50 bytes, expected 100/);
});
