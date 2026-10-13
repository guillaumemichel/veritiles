// Output-stability guard for tools/pack.ts: the layout changes made for the
// Rust packer (top-meta running total, u32 shard spans, root-last ordering,
// post-order CARs) must not move any proof file or small full CAR that
// packed successfully before them. Proof digests and CARs were frozen from
// v0.4.0. The BLAKE3 map (v0.5) changes only `root` and so the anchor, which
// are pinned separately. v0.5 also splits a band too large for the top meta
// into several subdirectories, which moves nested trees by design (A-04).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { buildProofTree, packFixed, packPmtiles } from '../tools/pack.ts';
import { deterministicBytes, sha256Bytes, sha256Hex } from './helpers/bytes.ts';
import { writePmtilesArchive, type TileSpec } from './helpers/pmtiles-writer.ts';

// Order-independent digest over every proof file below `root` (path and bytes).
function proofsDigest(proofs: Map<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const path of [...proofs.keys()].sort()) if (path !== 'root') hash.update(path).update(proofs.get(path)!);
  return hash.digest('hex');
}

function filesDigest(files: { path: string; content: Uint8Array }[], topMeta: Uint8Array): string {
  return proofsDigest(new Map([...files.map((f) => [f.path, f.content] as const), ['top', topMeta]]));
}

const tiles: TileSpec[] = [
  { z: 0, x: 0, y: 0, data: deterministicBytes(500, 1) },
  { z: 1, x: 0, y: 0, data: deterministicBytes(1200, 2) },
  { z: 1, x: 1, y: 0, data: deterministicBytes(90, 3) },
  { z: 1, x: 0, y: 1, data: deterministicBytes(2048, 4) },
  { z: 2, x: 1, y: 2, data: deterministicBytes(3000, 6) },
  { z: 3, x: 5, y: 5, data: deterministicBytes(2900, 11) },
];

test('A-01 fixed profile with --unixfs: anchor, proofs, and full CAR are unchanged', async () => {
  const packed = await packFixed(deterministicBytes(3 * 1024 * 1024, 60), { chunkSize: 262144, unixfs: true });
  assert.equal(packed.anchor, 'bafyreicjykblunakrdd4dmmcliori2oglubl77n5x2q653oyorqyqjiipy');
  assert.equal(proofsDigest(packed.proofs), '3a775349cc80098137071375b4add5257dc764c574992daa8c24b1189fb8069c');
  assert.equal(sha256Hex(packed.fullCar!), '8076751155d07949ad7d0b30faca2982eb839b8a95b0ec033ec2548824b2dd39');
});

test('A-02 fixed profile spanning several shards is unchanged', async () => {
  const packed = await packFixed(deterministicBytes(5000, 3), { chunkSize: 1 });
  assert.equal(packed.anchor, 'bafyreiagzfd5wjobgmeo7ieklcaoiy2x2mjxgsbinql4fbnvq4enoxd3be');
  assert.equal(proofsDigest(packed.proofs), 'ed87f3b0ebb7675feca5be8a89f5e9aab4c5715b9df3fb9da5c96d637fa2f08c');
});

test('A-03 PMTiles profile (zoom bands, leaf directories) is unchanged', async () => {
  const archive = writePmtilesArchive(tiles, { rootEntriesPerLeaf: 2 });
  const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 0 });
  assert.equal(packed.anchor, 'bafyreiallosgfpbujidege623harhwjampjsg6v3ubbpe3yfyonuordq2m');
  assert.equal(proofsDigest(packed.proofs), 'c3ad94aece0471eff23337b966ce68ab23fbd6eec51d6278f511b1d8b020ce06');
});

// Re-pinned for v0.5: the 5-shard middle band, over the 4-entry meta cap,
// now splits into two subdirectories listed in the top meta (3 and 2
// shards) instead of one left-shallow subdirectory tree.
test('A-04 a nested proof tree (small meta cap, several bands) is unchanged since v0.5', () => {
  const leaves = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({
    offset: start + i,
    length: 1,
    digest: sha256Bytes(Uint8Array.of(i & 0xff, i >> 8)),
  }));
  const bands = [leaves(0, 3000), leaves(3000, 9100), leaves(12100, 40)];
  const { files, topMeta } = buildProofTree(bands, { metaMaxEntries: 4 });
  assert.equal(filesDigest(files, topMeta), 'a030488f59dc0921cd98e853dd92722265a64ac287c5ec0536462e41b79153e3');
});
