// Pack tool suite (PLAN-shards §5 S5): the fixed profile, the PMTiles
// profile with zoom shaping, descriptor/proof-tree emission, and the
// round-trip verifier.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { CID } from 'multiformats/cid';

import {
  buildProofTree,
  choosePmtilesTileGroup,
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
import { blake3Bytes, deterministicBytes, flipByte } from './helpers/bytes.ts';
import { assemblePmtiles, compress, compressPadded, encodeDirectory, writePmtilesArchive, writeRawPmtilesArchive, zstdWithChecksum, type TileSpec } from './helpers/pmtiles-writer.ts';

const bytes = deterministicBytes(3 * 1024 * 1024, 60);


test('T-01 the fixed profile binds the raw whole-file CID', async () => {
  const packed = await packFixed(bytes); // default chunk = 1 MiB
  const map = CID.parse(packed.mapCid);
  assert.equal(map.code, 0x55);
  assert.equal(map.multihash.code, 0x1e);
  assert.deepEqual(map.multihash.digest, await blake3Bytes(bytes));
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

test('T-04a --unixfs emits a standard UnixFS root and a pinnable CAR without changing map CID', async () => {
  const plain = await packFixed(bytes, { chunkSize: 262144 });
  const packed = await packFixed(bytes, { chunkSize: 262144, unixfs: true });
  const descriptor = decodeDescriptor(packed.descriptor);
  assert.equal(packed.mapCid, plain.mapCid);
  assert.ok(packed.unixfsCid);
  assert.ok(packed.fullCar);
  assert.equal(CID.decode(descriptor.unixfsCid!.bytes).toString(), packed.unixfsCid);

  const store = new MemoryBlockstore();
  let expected: CID | undefined;
  for await (const entry of importer([{ content: bytes }], store, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: 262144 }),
  })) expected = entry.cid;
  assert.equal(packed.unixfsCid, expected!.toString());

  const reader = await CarReader.fromBytes(packed.fullCar);
  assert.ok(await reader.get(expected!));
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
  // A trailing byte the descriptor does not cover is caught too.
  const longer = new Uint8Array([...bytes, 0]);
  await assert.rejects(verifyBytes(packed.anchor, longer, packed.proofs, { reads: 1, seed: 7 }), /^Error: file is \d+ bytes, descriptor says \d+$/);
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

test('T-10 a band whose split does not fit the top meta nests one subdirectory (depth 2)', async () => {
  // 5 shards > 4 meta entries, and a 1-entry top meta has no room for the
  // two directories a split needs → the top meta delegates to one subdirectory.
  const { buildProofTree } = await import('../tools/pack.ts');
  const { sha256Bytes } = await import('./helpers/bytes.ts');
  const leaves = Array.from({ length: 9100 }, (_, i) => ({
    offset: i,
    length: 1,
    digest: sha256Bytes(Uint8Array.of(i & 0xff)),
  }));
  const { files, topMeta } = buildProofTree([leaves], { metaMaxEntries: 4, topMaxEntries: 1 });
  const { entries, covered } = decodeMeta(topMeta, 0);
  assert.equal(covered, 9100);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, KIND_DIR);
  const name = entries[0]!.start.toString(16);
  assert.ok(files.some((f) => f.path === `${name}/meta`), 'subdirectory meta emitted');
  assert.ok(files.filter((f) => f.path.startsWith(`${name}/`)).length > 1, 'shards live inside the subdirectory');
});

test('T-11 the full CAR is in DAG post-order, each block once', async () => {
  // 176 chunks need two dag-pb levels (174 links per node); chunks repeat
  // with period 3, so raw leaves are shared between parents.
  const chunk = 262144;
  const content = new Uint8Array(176 * chunk + 1);
  const patterns = [0, 1, 2].map((i) => deterministicBytes(chunk, 100 + i));
  for (let i = 0; i < 176; i++) content.set(patterns[i % 3]!, i * chunk);
  const packed = await packFixed(content, { chunkSize: content.length, unixfs: true });
  const reader = await CarReader.fromBytes(packed.fullCar!);
  const blocks = new Map<string, Uint8Array>();
  const order: string[] = [];
  for await (const block of reader.blocks()) {
    order.push(block.cid.toString());
    blocks.set(block.cid.toString(), block.bytes);
  }
  const expected: string[] = [];
  const visit = (cid: CID): void => {
    const key = cid.toString();
    if (expected.includes(key)) return;
    if (cid.code === 0x70) for (const link of dagPb.decode(blocks.get(key)!).Links) visit(link.Hash);
    expected.push(key);
  };
  visit(CID.parse(packed.unixfsCid!));
  assert.equal(order.length, new Set(order).size, 'each CID once');
  assert.deepEqual(order, expected);
});

test('T-12 pack rejects a bad chunk size', async () => {
  await assert.rejects(packFixed(bytes, { chunkSize: 0 }), /bad chunk size: 0/);
  await assert.rejects(packFixed(bytes, { chunkSize: 1.5 }), /bad chunk size: 1.5/);
  assert.throws(() => parseChunk('99999999999999999999'), /bad --chunk value: 99999999999999999999/);
  assert.throws(() => parseChunk('9007199254740991K'), /bad --chunk value/);
  assert.throws(() => parseChunk('4GiB', '--tile-group'), /bad --tile-group value: 4GiB/);
});

test('T-13 profile selection is strict', async () => {
  const archive = writePmtilesArchive(pmtilesTiles);
  await assert.rejects(pack(bytes, { profile: 'pmtiles' }), /not a PMTiles v3 archive/);
  await assert.rejects(pack(bytes, { profile: 'bogus' as never }), /unknown profile: bogus/);
  await assert.rejects(pack(archive.bytes, { chunkSize: 1024 }), /--chunk applies only to the fixed profile/);
  await assert.rejects(pack(bytes, { tileGroupBytes: 1024 }), /--tile-group applies only to the pmtiles profile/);
  await assert.rejects(pack(archive.bytes, { profile: 'fixed', tileGroupBytes: 0 }), /--tile-group applies only to the pmtiles profile/);
});

test('T-14 root is the last proof file', async () => {
  const packed = await packFixed(bytes, { chunkSize: 1024 });
  assert.equal([...packed.proofs.keys()].at(-1), 'root');
});

test('T-15 PMTiles tiles must have u32 lengths and safe-integer tile ids', async () => {
  const tooLong = writeRawPmtilesArchive([{ id: 0, offset: 0, length: 2 ** 32, runLength: 1 }], 16);
  await assert.rejects(parsePmtiles(tooLong), /^Error: PMTiles tile length exceeds 0xffffffff$/);
  const unsafeId = writeRawPmtilesArchive([{ id: 2 ** 54, offset: 0, length: 16, runLength: 1 }], 16);
  await assert.rejects(parsePmtiles(unsafeId), /^Error: PMTiles tile id is not a safe integer$/);
  const ok = writeRawPmtilesArchive([{ id: 5, offset: 0, length: 16, runLength: 1 }], 16);
  assert.equal((await parsePmtiles(ok)).tileRanges.length, 1);
});

const GiB4 = 2 ** 32;
const bigLeaves = (count: number, length: number) => Array.from({ length: count }, (_, i) => ({
  offset: i * length,
  length,
  digest: new Uint8Array(32).fill(i & 0xff),
}));

test('T-16 a shard closes before a relative offset would overflow u32', () => {
  const at = (n: number) => buildProofTree([bigLeaves(n, 2 ** 31)]);
  const { topMeta } = at(3);
  const { entries } = decodeMeta(topMeta, 0);
  assert.deepEqual(entries.map((e) => [e.start, e.length]), [[0, GiB4], [GiB4, 2 ** 31]]);
  // A relative offset of exactly 0xffffffff still fits.
  const edge = [{ offset: 0, length: 0xffffffff, digest: new Uint8Array(32) }, { offset: 0xffffffff, length: 1, digest: new Uint8Array(32) }];
  assert.equal(decodeMeta(buildProofTree([edge]).topMeta, 0).entries.length, 1);
});

test('T-17 the top meta inlines bands only while it stays within 1,598 entries', () => {
  // 1,599 one-leaf shards in one band: inlining would overflow the
  // descriptor's 2-byte meta length, so the band splits into five
  // subdirectories of at most 399 shards: 320, 320, 320, 320 and 319.
  const { topMeta, files } = buildProofTree([bigLeaves(1599, GiB4)]);
  const { entries } = decodeMeta(topMeta, 0);
  assert.deepEqual(entries.map((e) => [e.kind, e.length / GiB4]), [[KIND_DIR, 320], [KIND_DIR, 320], [KIND_DIR, 320], [KIND_DIR, 320], [KIND_DIR, 319]]);
  assert.ok(files.some((f) => f.path === '0/meta'));
  assert.ok(files.some((f) => f.path === `${(320 * GiB4).toString(16)}/meta`));
  // Running total: a later band that would push past the limit nests too.
  const small = buildProofTree([bigLeaves(2, GiB4), bigLeaves(2, GiB4).map((l) => ({ ...l, offset: l.offset + 2 * GiB4 }))], { metaMaxEntries: 4, topMaxEntries: 3 });
  assert.deepEqual(decodeMeta(small.topMeta, 0).entries.map((e) => e.kind), [KIND_SHARD, KIND_SHARD, KIND_DIR]);
  // Each later non-empty band keeps one slot: [1598 shards, 1 shard] nests
  // the first band (five subdirectories) rather than leaving no room for the
  // second.
  const reserved = buildProofTree([bigLeaves(1598, GiB4), [], [{ offset: 1598 * GiB4, length: 1, digest: new Uint8Array(32) }]]);
  assert.deepEqual(decodeMeta(reserved.topMeta, 0).entries.map((e) => e.kind), [KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR, KIND_SHARD]);
  // More bands than the top meta can list is an error.
  const bands = bigLeaves(1599, 1).map((leaf) => [leaf]);
  assert.throws(() => buildProofTree(bands), /^Error: top meta needs 1599 entries, over the 1598 limit$/);
});

// Library error texts (zlib codes, V8 JSON positions) vary across Node
// versions and cannot be mirrored by the Rust packer, so each failure class
// has one fixed message.
test('T-18 PMTiles decompression failures have one message per codec', async () => {
  const root = encodeDirectory([{ id: 0, offset: 0, length: 1, runLength: 1 }]);
  const metadata = (compression: number) => compress(new TextEncoder().encode('{}'), compression);
  const archive = (stored: Uint8Array, compression: number) =>
    assemblePmtiles({ root: stored, metadata: metadata(compression), compression, tiles: new Uint8Array(1) });
  const gzipJunk = Uint8Array.from([...compress(root, 2), 0x41]);
  await assert.rejects(parsePmtiles(archive(gzipJunk, 2)), /^Error: PMTiles gzip decompression failed$/);
  const brotliCut = compress(root, 3).subarray(0, 2);
  await assert.rejects(parsePmtiles(archive(brotliCut, 3)), /^Error: PMTiles brotli decompression failed$/);
  await assert.rejects(parsePmtiles(archive(Uint8Array.from([1, 2, 3, 4, 5]), 4)), /^Error: PMTiles zstd decompression failed$/);
  // Node's quirks are kept: trailing zeros after gzip are padding.
  const gzipPadded = Uint8Array.from([...compress(root, 2), 0, 0x41]);
  assert.equal((await parsePmtiles(archive(gzipPadded, 2))).tileRanges.length, 1);
});

test('T-19 PMTiles metadata that is not JSON has one message', async () => {
  const root = encodeDirectory([{ id: 0, offset: 0, length: 1, runLength: 1 }]);
  const withMetadata = (text: string) => assemblePmtiles({ root, metadata: new TextEncoder().encode(text), tiles: new Uint8Array(1) });
  await assert.rejects(parsePmtiles(withMetadata('{"a":')), /^Error: PMTiles metadata is not valid JSON$/);
  await assert.rejects(parsePmtiles(withMetadata('[]')), /^Error: PMTiles metadata must be a JSON object$/);
  assert.equal((await parsePmtiles(withMetadata('\ufeff{"a":1e400}'))).tileRanges.length, 1);
});

const CAP = 256 * 1024 * 1024;
const CODECS: [number, string][] = [[2, 'gzip'], [3, 'brotli'], [4, 'zstd']];
const oneTileRoot = encodeDirectory([{ id: 0, offset: 0, length: 1, runLength: 1 }]);
const leafArchive = (leaf: Uint8Array, compression: number, tiles = 1) => assemblePmtiles({
  root: compress(encodeDirectory([{ id: 0, offset: 0, length: leaf.length, runLength: 0 }]), compression),
  leaves: leaf,
  metadata: compress(new TextEncoder().encode('{}'), compression),
  compression,
  tiles: new Uint8Array(tiles),
});

test('T-20 PMTiles blocks decompress to at most 256 MiB', async () => {
  const json = new TextEncoder().encode('{}');
  const withMetadata = (metadata: Uint8Array, compression: number) =>
    assemblePmtiles({ root: compress(oneTileRoot, compression), metadata, compression, tiles: new Uint8Array(1) });
  for (const [code, name] of CODECS) {
    const failed = new RegExp(`^Error: PMTiles ${name} decompression failed$`);
    await assert.rejects(parsePmtiles(withMetadata(compressPadded(json, CAP + 1, code), code)), failed);
    await assert.rejects(parsePmtiles(leafArchive(compressPadded(oneTileRoot, CAP + 1, code, 0), code)), failed);
  }
  // Exactly the cap decodes: trailing directory bytes are ignored.
  assert.equal((await parsePmtiles(withMetadata(compressPadded(json, CAP, 4), 4))).metadata.length, CAP);
  assert.equal((await parsePmtiles(leafArchive(compressPadded(oneTileRoot, CAP, 4, 0), 4))).tileRanges.length, 1);
});

// Node 22 and 24 disagree on truncated zstd frames and on bytes after a
// frame, so neither defines the format: a block is one complete frame.
test('T-25 a zstd block is exactly one complete frame', async () => {
  const json = new TextEncoder().encode('{"a":1}');
  const withMetadata = (metadata: Uint8Array) =>
    assemblePmtiles({ root: compress(oneTileRoot, 4), metadata, compression: 4, tiles: new Uint8Array(1) });
  const frame = compress(json, 4);
  const checked = zstdWithChecksum(json);
  const skippable = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 9);
  for (const whole of [frame, checked]) assert.deepEqual((await parsePmtiles(withMetadata(whole))).metadata, json);
  const broken = [
    Uint8Array.from([...frame, ...frame]),
    Uint8Array.from([...frame, 0x41]),
    frame.subarray(0, frame.length - 1),
    checked.subarray(0, checked.length - 1),
    new Uint8Array(0),
    skippable,
    Uint8Array.from([...skippable, ...frame]),
  ];
  for (const bytes of broken) await assert.rejects(parsePmtiles(withMetadata(bytes)), /^Error: PMTiles zstd decompression failed$/);
});

test('T-21 a leaf directory may hold 200,000 entries', async () => {
  const count = 200_000;
  const leaf = encodeDirectory(Array.from({ length: count }, (_, i) => ({ id: i, offset: i, length: 1 })));
  assert.equal((await parsePmtiles(leafArchive(leaf, 1, count))).tileRanges.length, count);
});

test('T-22 sections after the tile data (the planet layout) form their own band', async () => {
  const leaf = encodeDirectory([{ id: 0, offset: 0, length: 300 }, { id: 1, offset: 300, length: 200 }]);
  const root = encodeDirectory([{ id: 0, offset: 0, length: leaf.length, runLength: 0 }]);
  const metadata = new TextEncoder().encode('{}');
  const bytes = assemblePmtiles({ root, leaves: leaf, metadata, tiles: deterministicBytes(500, 5), order: ['root', 'tiles', 'metadata', 'leaves'] });
  const packed = await packPmtiles(bytes, { tileGroupBytes: 0 });
  const { entries } = decodeMeta(decodeDescriptor(packed.descriptor).topMeta, 0);
  assert.deepEqual(entries.map((e) => e.length), [127 + root.length, 300, 200, metadata.length + leaf.length]);
  assert.equal(await verifyBytes(packed.anchor, bytes, packed.proofs), 32);
});

// `count` one-leaf shards, the first at `first` × 4 GiB.
const shardRun = (first: number, count: number) =>
  bigLeaves(count, GiB4).map((leaf) => ({ ...leaf, offset: leaf.offset + first * GiB4 }));
const topShape = (tree: { topMeta: Uint8Array }) =>
  decodeMeta(tree.topMeta, 0).entries.map((e) => [e.kind, e.length / GiB4]);

test('T-23 a band too large for the top meta splits into balanced subdirectories', () => {
  // 7 shards, at most 3 per directory: 3 directories, sizes within one of
  // each other and the larger first.
  const uneven = buildProofTree([shardRun(0, 7)], { topMaxEntries: 3, subMetaMaxEntries: 3 });
  assert.deepEqual(topShape(uneven), [[KIND_DIR, 3], [KIND_DIR, 2], [KIND_DIR, 2]]);
  // Each directory is named by its first shard, and its meta lists only its shards.
  const dir = (3 * GiB4).toString(16);
  const inDir = uneven.files.filter((f) => f.path.startsWith(`${dir}/`));
  assert.deepEqual(inDir.map((f) => f.path), [`${dir}/${dir}`, `${dir}/${(4 * GiB4).toString(16)}`, `${dir}/meta`]);
  assert.deepEqual(decodeMeta(inDir[2]!.content, 3 * GiB4).entries.map((e) => e.kind), [KIND_SHARD, KIND_SHARD]);
  // An exact multiple splits evenly.
  const even = buildProofTree([shardRun(0, 6)], { topMaxEntries: 3, subMetaMaxEntries: 2 });
  assert.deepEqual(topShape(even), [[KIND_DIR, 2], [KIND_DIR, 2], [KIND_DIR, 2]]);
  // A directory never holds more than a meta may.
  const clamped = buildProofTree([shardRun(0, 7)], { metaMaxEntries: 2, topMaxEntries: 4, subMetaMaxEntries: 3 });
  assert.deepEqual(topShape(clamped), [[KIND_DIR, 2], [KIND_DIR, 2], [KIND_DIR, 2], [KIND_DIR, 1]]);
  // The directories must fit with a slot kept for each later band; when
  // they do not, the band becomes one directory, as before.
  const bands = [shardRun(0, 7), shardRun(7, 1)];
  assert.deepEqual(topShape(buildProofTree(bands, { topMaxEntries: 4, subMetaMaxEntries: 3 })), [[KIND_DIR, 3], [KIND_DIR, 2], [KIND_DIR, 2], [KIND_SHARD, 1]]);
  assert.deepEqual(topShape(buildProofTree(bands, { topMaxEntries: 3, subMetaMaxEntries: 3 })), [[KIND_DIR, 7], [KIND_SHARD, 1]]);
});

test('T-24 the default tile group is the smallest that keeps every shard in the top meta', async () => {
  // One 11 KiB tile per zoom: a 16 KiB group holds one tile, 32 KiB two and
  // 64 KiB all three, so the head band and the zoom bands take 4, 3 or 2 shards.
  const archive = writePmtilesArchive([0, 1, 2].map((z) => ({ z, x: 0, y: 0, data: deterministicBytes(11 * 1024, z + 1) })));
  const parsed = await parsePmtiles(archive.bytes);
  const choose = (topMaxEntries?: number) => choosePmtilesTileGroup(parsed, archive.bytes.length, { topMaxEntries });
  assert.deepEqual([4, 3, 2, 1].map(choose), [16384, 32768, 65536, 65536]);
  assert.equal(choose(), 16384);
  // Without a budget, packing uses the choice; it reports the budget either way.
  const packed = await packPmtiles(archive.bytes);
  assert.equal(packed.tileGroupBytes, 16384);
  assert.deepEqual(packed.cuts, await derivePmtilesCuts(archive.bytes, { tileGroupBytes: 16384 }));
  assert.deepEqual(await derivePmtilesCutPoints(archive.bytes), await derivePmtilesCutPoints(archive.bytes, { tileGroupBytes: 16384 }));
  assert.equal((await packPmtiles(archive.bytes, { tileGroupBytes: 0 })).tileGroupBytes, 0);
  assert.equal((await packFixed(archive.bytes)).tileGroupBytes, undefined);
});

async function codecs(car: Uint8Array): Promise<number[]> {
  const reader = await CarReader.fromBytes(car);
  const out: number[] = [];
  for await (const b of reader.blocks()) out.push(b.cid.code);
  return out;
}
