// End to end through the REAL pmtiles reader (PLAN-shards §5 S4): a genuine
// (minimal) PMTiles v3 archive, packed by tools/pack.ts (descriptor + shard
// tree, zoom-shaped), served by an in-memory dumb host, opened with
// `new PMTiles(new VerifiedSource)`. This is exactly the wiring a MapLibre /
// Leaflet / OpenLayers consumer uses.
//
// The archive is sized so that at least one tile lies entirely beyond the
// reader's unconditional 16 KiB header probe, so the last on-disk tile is cold.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PMTiles } from 'pmtiles';

import { VerifiedSource } from '../src/index.ts';
import { packPmtiles } from '../tools/pack.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { servePackage, type FileHostHooks } from './helpers/serve-file.ts';
import { writePmtilesArchive, type TileSpec } from './helpers/pmtiles-writer.ts';

const HEADER_PROBE = 16384;
const FILE_URL = 'https://tiles.example/map.pmtiles';

const tiles: TileSpec[] = [
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
const archive = writePmtilesArchive(tiles);
// Pack with the PMTiles publisher profile: one leaf per physical tile range.
const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 0 });

const tileData = (z: number, x: number, y: number) => tiles.find((t) => t.z === z && t.x === x && t.y === y)!.data;

function openPmtiles(hooks: FileHostHooks = {}) {
  const { fetch, requests } = servePackage(FILE_URL, archive.bytes, packed.proofs, hooks);
  const source = new VerifiedSource({ cid: packed.anchor, source: FILE_URL, fetchFn: fetch });
  return { pm: new PMTiles(source), source, requests };
}

test('the fixture leaves a tile beyond the header probe for every ordering', () => {
  const last = archive.tiles.at(-1)!;
  assert.ok(last.offset >= HEADER_PROBE, `last tile starts at ${last.offset}, inside the ${HEADER_PROBE} B probe`);
});

test('E-01 the real pmtiles reader parses the verified header', async () => {
  const { pm } = openPmtiles();
  const header = await pm.getHeader();
  assert.equal(header.minZoom, 0);
  assert.equal(header.maxZoom, 3);
  assert.equal(header.tileType, 1); // mvt
  assert.equal(header.clustered, true);
  assert.equal(header.tileDataOffset, archive.tileDataOffset);
});

test('E-02 every tile round-trips byte-identical through getZxy', async () => {
  const { pm, source } = openPmtiles();
  for (const t of tiles) {
    const result = await pm.getZxy(t.z, t.x, t.y);
    assert.ok(result, `tile ${t.z}/${t.x}/${t.y} present`);
    assert.deepEqual(new Uint8Array(result.data), t.data, `tile ${t.z}/${t.x}/${t.y}`);
  }
  assert.equal(source.stats.rejected, 0);
  assert.ok(source.stats.verified >= tiles.length);
});

test('E-03 a tile absent from the archive resolves to undefined, not an error', async () => {
  const { pm } = openPmtiles();
  assert.equal(await pm.getZxy(2, 0, 0), undefined);
  assert.equal(await pm.getZxy(5, 9, 9), undefined);
});

test('E-04 metadata round-trips', async () => {
  const { pm } = openPmtiles();
  assert.deepEqual(await pm.getMetadata(), {});
});

test('E-05 a cold tile beyond the probe costs exactly one range request', async () => {
  const ranges: string[] = [];
  const { pm } = openPmtiles({ onRequest: (_, h) => h?.Range && ranges.push(h.Range) });
  await pm.getHeader(); // warms [0, probe-run end)
  ranges.length = 0;
  const cold = archive.tiles.at(-1)!;
  const result = await pm.getZxy(cold.z, cold.x, cold.y);
  assert.deepEqual(new Uint8Array(result!.data), tileData(cold.z, cold.x, cold.y));
  assert.equal(ranges.length, 1, `one range per cold tile, got: ${ranges.join(', ') || 'none'}`);
  assert.equal(ranges[0], `bytes=${cold.offset}-${cold.offset + cold.length - 1}`);
});

test('E-06 tampered tile bytes never reach the renderer', async () => {
  const { pm, source } = openPmtiles({ tamperRange: (b) => flipByte(b) });
  const t = tiles[0]!;
  await assert.rejects(pm.getZxy(t.z, t.x, t.y));
  assert.ok(source.stats.rejected >= 1, 'the tamper was detected, not silently rendered');
});

test('E-07 a tampering host is survived when a clean mirror is configured', async () => {
  const evil = servePackage('https://evil.example/m', archive.bytes, packed.proofs, { tamperRange: (b) => flipByte(b) });
  const good = servePackage('https://mirror.example/m', archive.bytes, packed.proofs);
  const routed = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).startsWith('https://evil.example') ? evil.fetch : good.fetch;
    return target(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const source = new VerifiedSource({
    cid: packed.anchor,
    source: ['https://evil.example/m', 'https://mirror.example/m'],
    proof: 'https://mirror.example/m.proofs',
    fetchFn: routed,
  });
  const pm = new PMTiles(source);
  for (const t of tiles) {
    const result = await pm.getZxy(t.z, t.x, t.y);
    assert.deepEqual(new Uint8Array(result!.data), t.data, `tile ${t.z}/${t.x}/${t.y}`);
  }
  assert.ok(source.stats.rejected >= 1, 'the tampering host was caught');
  assert.equal(source.getKey(), packed.anchor);
});

test('E-08 cold reads fetch only the descriptor plus covering shards', async () => {
  const { pm, requests } = openPmtiles();
  await pm.getHeader();
  const coldProofGets = requests.filter((u) => u.includes('.proofs/'));
  assert.deepEqual(coldProofGets.slice(0, 1), [`${FILE_URL}.proofs/root`], 'descriptor first');
  // The 16 KiB probe spans the head band and the z0–z2 bands: one shard per
  // covering band, each fetched exactly once (no metas — depth-1 tree).
  assert.ok(coldProofGets.length <= 5, `descriptor + covering shards, got ${coldProofGets.join(', ')}`);
  requests.length = 0;
  const cold = archive.tiles.at(-1)!;
  await pm.getZxy(cold.z, cold.x, cold.y);
  const proofGets = requests.filter((u) => u.includes('.proofs/'));
  assert.ok(proofGets.length <= 1, `new region: ≤1 proof fetch, got ${proofGets.join(', ')}`);
  requests.length = 0;
  await pm.getZxy(cold.z, cold.x, cold.y);
  assert.equal(requests.length, 0, 'fully warm: zero requests');
});
