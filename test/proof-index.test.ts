import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KIND_SHARD } from '../src/proof-format.ts';
import { ProofIndex } from '../src/proof-index.ts';
import { RangeSource } from '../src/range-source.ts';
import { toHex } from '../src/verify.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte, sha256Bytes, sha256Hex } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { buildMapPackage, type MapPackage } from './helpers/package.ts';
import { encodeMeta, encodeShard } from './helpers/proof-encode.ts';

const mapBytes = deterministicBytes(4000, 40);
const cuts = [100, 900, 2000, 500, 500];

function indexOver(fixture: MapPackage, opts: HostOptions = {}) {
  const store = new VerifiedStore([
    new RangeSource('.', { fetchFn: rangeFetch(fixture.files, opts) }),
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(fixture.files.get('metadata.json')!));
  const index = new ProofIndex(store, {
    dir: 'proofs',
    metaDigest: manifest.proofs.metaDigest,
    fileSize: manifest.map.size,
  });
  return { index, store };
}

const asHex = (leaves: MapPackage['leaves']) =>
  leaves.map((l) => ({ offset: l.offset, length: l.length, digest: toHex(l.digest) }));

test('full-range descent recovers every leaf digest', async () => {
  const fixture = await buildMapPackage({ mapBytes, cuts });
  const { index } = indexOver(fixture);
  assert.deepEqual(await index.leavesFor(0, 4000), asHex(fixture.leaves));
});

test('sub-range descent returns exactly the covering leaves', async () => {
  const fixture = await buildMapPackage({ mapBytes, cuts });
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
  const fixture = await buildMapPackage({
    mapBytes: deterministicBytes(4000, 41),
    cuts: lengths,
    shardCap: 40,
    metaMaxEntries: 4,
  });
  const proofRequests: string[] = [];
  const { index } = indexOver(fixture, {
    onRequest: (url) => url.includes('proofs/') && proofRequests.push(url),
  });

  // A tail read must not fetch any head shard file.
  const tail = await index.leavesFor(3900, 4000);
  assert.equal(tail.length, 1);
  assert.deepEqual(tail, asHex(fixture.leaves).slice(-1));
  const headShard = 'proofs/0000000000000000';
  assert.ok(
    !proofRequests.some((u) => u.endsWith(headShard)),
    `tail read fetched head shard: ${proofRequests.join(', ')}`,
  );
  assert.ok(proofRequests.length >= 2, 'descends through nested metas');

  // The head read touches the top meta + head shard only (both depth 0).
  proofRequests.length = 0;
  await index.leavesFor(0, 100);
  assert.ok(proofRequests.some((u) => u.endsWith(headShard)));
});

test('a tampered shard is rejected', async () => {
  const fixture = await buildMapPackage({ mapBytes, cuts });
  const shardPath = [...fixture.files.keys()].find(
    (p) => p.startsWith('proofs/') && !p.endsWith('meta'),
  )!;
  const files = new Map(fixture.files);
  files.set(shardPath, flipByte(files.get(shardPath)!));
  const { index } = indexOver({ ...fixture, files });
  await assert.rejects(index.leavesFor(0, 4000), AggregateError);
});

test('repeat reads are served from the cached shard buffer: no second fetch', async () => {
  const fixture = await buildMapPackage({ mapBytes, cuts });
  const proofRequests: string[] = [];
  const { index } = indexOver(fixture, {
    onRequest: (url) => url.includes('proofs/') && proofRequests.push(url),
  });
  const first = await index.leavesFor(0, 4000);
  const fetched = proofRequests.length;
  assert.deepEqual(await index.leavesFor(0, 4000), first);
  assert.equal(proofRequests.length, fetched, 'repeat read fetches no proof files');
});

test('cachedLeavesFor answers synchronously once proofs are cached, null before', async () => {
  const fixture = await buildMapPackage({ mapBytes, cuts });
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
    new RangeSource('.', {
      fetchFn: rangeFetch(
        new Map([
          ['proofs/meta', meta],
          ['proofs/0000000000000000', shard],
        ]),
      ),
    }),
  ]);
  const index = new ProofIndex(store, { dir: 'proofs', metaDigest: sha256Hex(meta), fileSize: 50 });
  await assert.rejects(index.leavesFor(0, 50), /outside the 50-byte span/);
});

test('a meta whose coverage disagrees with its parent is rejected', async () => {
  // Valid digest, wrong coverage: a hand-built meta covering 50 bytes offered
  // for a 100-byte file — catches an inconsistent build or swapped files.
  const shard = deterministicBytes(35, 42);
  const meta = encodeMeta([{ kind: KIND_SHARD, length: 50, digest: sha256Bytes(shard) }]);
  const store = new VerifiedStore([
    new RangeSource('.', { fetchFn: rangeFetch(new Map([['proofs/meta', meta]])) }),
  ]);
  const index = new ProofIndex(store, {
    dir: 'proofs',
    metaDigest: sha256Hex(meta),
    fileSize: 100,
  });
  await assert.rejects(index.leavesFor(0, 100), /covers 50 bytes, expected 100/);
});
