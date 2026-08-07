// Pack tool suite (PLAN-shards §5 S5): the fixed profile, the PMTiles
// profile with zoom shaping, descriptor/proof-tree emission, and the
// round-trip verifier.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';

import {
  derivePmtilesCutPoints,
  derivePmtilesCuts,
  pack,
  packFixed,
  packPmtiles,
  parseChunk,
  parsePmtiles,
  verifyBytes,
} from '../tools/pack.ts';
import { decodeDescriptor } from '../src/descriptor.ts';
import { KIND_DIR, KIND_SHARD, decodeMeta } from '../src/proof-format.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { writePmtilesArchive, type TileSpec } from './helpers/pmtiles-writer.ts';

const bytes = deterministicBytes(3 * 1024 * 1024, 60);


test('T-01 the fixed profile binds the raw whole-file CID', async () => {
  const packed = await packFixed(bytes); // default chunk = 1 MiB
  assert.equal(CID.parse(packed.mapCid).code, 0x55);
  assert.equal(packed.leafCount, 3);
});

test('T-02 proof chunking does not change the whole-file map CID', async () => {
  assert.equal((await packFixed(bytes, { chunkSize: 262144 })).mapCid, (await packFixed(bytes, { chunkSize: parseChunk('1MiB') })).mapCid);
  assert.equal(parseChunk('256KiB'), 262144);
  assert.equal(parseChunk('1M'), 1048576);
});

test('T-03 the descriptor and proof tree are byte-reproducible', async () => {
  const a = await packFixed(bytes, { chunkSize: 262144 });
  const b = await packFixed(bytes, { chunkSize: 262144 });
  assert.deepEqual(a.descriptor, b.descriptor);
  assert.equal(a.anchor, b.anchor);
  assert.deepEqual([...a.proofs.keys()], [...b.proofs.keys()]);
  for (const [path, content] of a.proofs) assert.deepEqual(content, b.proofs.get(path));
});

test('T-04 the descriptor binds the map CID, size, and a covering top meta', async () => {
  const packed = await packFixed(bytes, { chunkSize: 262144 });
  const d = decodeDescriptor(packed.descriptor);
  assert.equal(CID.decode(d.mapCid.bytes).toString(), packed.mapCid);
  assert.equal(d.mapSize, bytes.length);
  const { covered } = decodeMeta(d.topMeta, 0);
  assert.equal(covered, bytes.length);
  assert.equal(packed.proofs.get('root'), packed.descriptor);
});


test('T-05 verify round-trips the emitted package and catches tampering', async () => {
  const packed = await packFixed(bytes, { chunkSize: 262144 });
  const checked = await verifyBytes(packed.anchor, bytes, packed.proofs, { reads: 40, seed: 7 });
  assert.equal(checked, 40);
  // A flipped content byte is caught.
  await assert.rejects(verifyBytes(packed.anchor, flipByte(bytes, 1000), packed.proofs, { reads: 40, seed: 7 }));
  // A flipped proof byte is caught (a shard or meta fails its digest).
  const shardPath = [...packed.proofs.keys()].find((p) => p !== 'root' && !p.endsWith('meta'))!;
  const badProofs = new Map(packed.proofs);
  badProofs.set(shardPath, flipByte(badProofs.get(shardPath)!));
  await assert.rejects(verifyBytes(packed.anchor, bytes, badProofs, { reads: 40, seed: 7 }));
  // A flipped descriptor byte breaks the anchor hash at open.
  const badRoot = new Map(packed.proofs);
  badRoot.set('root', flipByte(badRoot.get('root')!));
  await assert.rejects(verifyBytes(packed.anchor, bytes, badRoot, { reads: 1, seed: 7 }));
});

const pmtilesTiles: TileSpec[] = [
  { z: 0, x: 0, y: 0, data: deterministicBytes(500, 1) },
  { z: 1, x: 0, y: 0, data: deterministicBytes(1200, 2) },
  { z: 1, x: 1, y: 0, data: deterministicBytes(90, 3) },
  { z: 1, x: 0, y: 1, data: deterministicBytes(2048, 4) },
  { z: 1, x: 1, y: 1, data: deterministicBytes(1, 5) },
  { z: 2, x: 1, y: 2, data: deterministicBytes(3000, 6) },
  { z: 2, x: 3, y: 3, data: deterministicBytes(2600, 7) },
  { z: 2, x: 0, y: 1, data: deterministicBytes(2500, 8) },
  { z: 2, x: 2, y: 2, data: deterministicBytes(2800, 9) },
  { z: 2, x: 3, y: 0, data: deterministicBytes(2700, 10) },
  { z: 3, x: 5, y: 5, data: deterministicBytes(2900, 11) },
];

test('T-06 parses PMTiles sections and cuts each tile when grouping is disabled', async () => {
  const archive = writePmtilesArchive(pmtilesTiles, { rootEntriesPerLeaf: 2 });
  const parsed = await parsePmtiles(archive.bytes);
  assert.equal(parsed.header.rootDirectoryOffset, 127);
  assert.equal(parsed.leafDirectories.length, 6);
  assert.deepEqual(parsed.metadata, new TextEncoder().encode('{}'));
  assert.equal(parsed.tileRanges.length, pmtilesTiles.length);

  const points = await derivePmtilesCutPoints(archive.bytes, { tileGroupBytes: 0 });
  assert.ok(points.includes(16384));
  assert.ok(points.includes(archive.tileDataOffset));
  for (const tile of archive.tiles) {
    assert.ok(points.includes(tile.offset), `missing tile start ${tile.offset}`);
    assert.ok(points.includes(tile.offset + tile.length), `missing tile end ${tile.offset + tile.length}`);
  }
  const cuts = await derivePmtilesCuts(archive.bytes, { tileGroupBytes: 0 });
  assert.equal(cuts.reduce((n, length) => n + length, 0), archive.bytes.length);
});

test('T-07 groups contiguous PMTiles tiles under the requested budget', async () => {
  const archive = writePmtilesArchive(pmtilesTiles);
  const cuts = await derivePmtilesCuts(archive.bytes, { tileGroupBytes: 8192 });
  assert.deepEqual(cuts, [127, 65, 2, 6339, 5800, 4051, 1249, 2900]);
  const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 8192 });
  assert.deepEqual(packed.cuts, cuts);
  await verifyBytes(packed.anchor, archive.bytes, packed.proofs, { reads: 12, seed: 9 });
});

test('T-08 profile selection uses PMTiles only for valid v3 magic and preserves fixed override', async () => {
  const archive = writePmtilesArchive(pmtilesTiles);
  const auto = await pack(archive.bytes);
  assert.deepEqual(auto.cuts, await derivePmtilesCuts(archive.bytes));

  const fixed = await pack(archive.bytes, { profile: 'fixed', chunkSize: 1024 });
  assert.equal(fixed.mapCid, (await packFixed(archive.bytes, { chunkSize: 1024 })).mapCid);

  const badVersion = archive.bytes.slice();
  badVersion[7] = 2;
  const fallback = await pack(badVersion, { chunkSize: 1024 });
  assert.equal(fallback.cuts, undefined);
  assert.equal(fallback.mapCid, (await packFixed(badVersion, { chunkSize: 1024 })).mapCid);
});

test('T-09 zoom shaping: the top meta partitions head + zoom bands in order', async () => {
  const archive = writePmtilesArchive(pmtilesTiles, { rootEntriesPerLeaf: 2 });
  const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 0 });
  const d = decodeDescriptor(packed.descriptor);
  const { entries } = decodeMeta(d.topMeta, 0);
  // Bands: head (header/rootdir/metadata/leafdirs) + z0 + z1 + z2 + z3 —
  // every band is small, so all entries are direct shard references.
  assert.ok(entries.every((e) => e.kind === KIND_SHARD || e.kind === KIND_DIR));
  const starts = entries.map((e) => e.start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts, 'entries are in file order');
  const tileDataStart = archive.tileDataOffset;
  const headEntries = entries.filter((e) => e.start < tileDataStart);
  const tileEntries = entries.filter((e) => e.start >= tileDataStart);
  // The head region (header/rootdir/metadata/leafdirs) is one shard.
  assert.equal(headEntries.length, 1);
  assert.equal(headEntries[0]!.start, 0);
  assert.equal(headEntries[0]!.length, tileDataStart);
  // Then one band per zoom level present: z0, z1, z2, z3.
  assert.equal(tileEntries.length, 4);
  assert.equal(tileEntries[0]!.start, tileDataStart);
});

test('T-10 a band exceeding the meta cap nests a subdirectory (depth 2)', async () => {
  // 5 shards > 4 meta entries → the top meta delegates to one subdirectory.
  const { buildProofTree } = await import('../tools/pack.ts');
  const { sha256Bytes } = await import('./helpers/bytes.ts');
  const leaves = Array.from({ length: 9100 }, (_, i) => ({
    offset: i,
    length: 1,
    digest: sha256Bytes(Uint8Array.of(i & 0xff)),
  }));
  const { files, topMeta } = buildProofTree([leaves], { metaMaxEntries: 4 });
  const { entries, covered } = decodeMeta(topMeta, 0);
  assert.equal(covered, 9100);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, KIND_DIR);
  const name = entries[0]!.start.toString(16);
  assert.ok(files.some((f) => f.path === `${name}/meta`), 'subdirectory meta emitted');
  assert.ok(files.filter((f) => f.path.startsWith(`${name}/`)).length > 1, 'shards live inside the subdirectory');
});

async function codecs(car: Uint8Array): Promise<number[]> {
  const reader = await CarReader.fromBytes(car);
  const out: number[] = [];
  for await (const b of reader.blocks()) out.push(b.cid.code);
  return out;
}
