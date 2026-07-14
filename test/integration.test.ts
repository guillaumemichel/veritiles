// End to end through the REAL pmtiles reader: a genuine (minimal) PMTiles
// v3 archive, packaged with real proofs by the canonical IPLD stack, served
// by an in-memory dumb host, opened with `new PMTiles(new VerifiedSource)`.
// This is exactly the wiring a MapLibre / Leaflet / OpenLayers consumer
// uses — if the Source contract drifts, this suite fails.
//
// The archive is sized so that at least one tile lies entirely beyond the
// reader's unconditional 16 KiB header probe (whose leaf-rounded run warms
// everything it touches): total tile bytes minus the largest tile exceeds
// 16 KiB, so the last on-disk tile is cold for every Hilbert ordering.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PMTiles } from 'pmtiles';

import { VerifiedSource } from '../src/index.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { buildMapPackage } from './helpers/package.ts';
import { writePmtilesArchive, type TileSpec } from './helpers/pmtiles-writer.ts';

const HEADER_PROBE = 16384;

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
const pkg = await buildMapPackage({ mapBytes: archive.bytes, cuts: archive.cuts });

const tileData = (z: number, x: number, y: number) =>
  tiles.find((t) => t.z === z && t.x === x && t.y === y)!.data;

// A ranged read into tile data — the bootstrap's plain GETs never match.
const tamperRanged: NonNullable<HostOptions['tamper']> = (path, range, bytes) =>
  path === 'map.pmtiles' && range ? flipByte(bytes) : bytes;

function openPmtiles(opts: HostOptions = {}) {
  const source = new VerifiedSource({
    rootCid: pkg.rootCid,
    source: 'https://tiles.example',
    fetchFn: rangeFetch(pkg.files, opts),
  });
  return { pm: new PMTiles(source), source };
}

test('the fixture leaves a tile beyond the header probe for every ordering', () => {
  const last = archive.tiles.at(-1)!;
  assert.ok(
    last.offset >= HEADER_PROBE,
    `last tile starts at ${last.offset}, inside the ${HEADER_PROBE} B probe`,
  );
});

test('the real pmtiles reader parses the verified header', async () => {
  const { pm } = openPmtiles();
  const header = await pm.getHeader();
  assert.equal(header.minZoom, 0);
  assert.equal(header.maxZoom, 3);
  assert.equal(header.tileType, 1); // mvt
  assert.equal(header.clustered, true);
  assert.equal(header.tileDataOffset, archive.tileDataOffset);
});

test('every tile round-trips byte-identical through getZxy', async () => {
  const { pm, source } = openPmtiles();
  for (const t of tiles) {
    const result = await pm.getZxy(t.z, t.x, t.y);
    assert.ok(result, `tile ${t.z}/${t.x}/${t.y} present`);
    assert.deepEqual(new Uint8Array(result.data), t.data, `tile ${t.z}/${t.x}/${t.y}`);
  }
  assert.equal(source.stats.rejected, 0);
  assert.ok(source.stats.verified >= tiles.length);
});

test('a tile absent from the archive resolves to undefined, not an error', async () => {
  const { pm } = openPmtiles();
  assert.equal(await pm.getZxy(2, 0, 0), undefined);
  assert.equal(await pm.getZxy(5, 9, 9), undefined);
});

test('metadata round-trips', async () => {
  const { pm } = openPmtiles();
  assert.deepEqual(await pm.getMetadata(), {});
});

test('a cold tile beyond the probe costs exactly one range request', async () => {
  const requests: string[] = [];
  const { pm } = openPmtiles({
    onRequest: (_, h) => {
      if (h?.Range) requests.push(h.Range);
    },
  });
  await pm.getHeader(); // warms [0, probe-run end)
  requests.length = 0;
  const cold = archive.tiles.at(-1)!;
  const result = await pm.getZxy(cold.z, cold.x, cold.y);
  assert.deepEqual(new Uint8Array(result!.data), tileData(cold.z, cold.x, cold.y));
  assert.equal(
    requests.length,
    1,
    `one range request per cold tile, got: ${requests.join(', ') || 'none'}`,
  );
  assert.equal(requests[0], `bytes=${cold.offset}-${cold.offset + cold.length - 1}`);
});

test('tampered tile bytes never reach the renderer', async () => {
  const { pm, source } = openPmtiles({ tamper: tamperRanged });
  const t = tiles[0]!;
  await assert.rejects(pm.getZxy(t.z, t.x, t.y));
  assert.ok(source.stats.rejected >= 1, 'the tamper was detected, not silently rendered');
});

test('a tampering host is survived when a clean mirror is configured', async () => {
  const evil = rangeFetch(pkg.files, { tamper: tamperRanged });
  const good = rangeFetch(pkg.files);
  const routed = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).startsWith('https://evil.example') ? evil : good;
    return target(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const source = new VerifiedSource({
    rootCid: pkg.rootCid,
    source: ['https://evil.example', 'https://mirror.example'],
    fetchFn: routed,
  });
  const pm = new PMTiles(source);
  for (const t of tiles) {
    const result = await pm.getZxy(t.z, t.x, t.y);
    assert.deepEqual(new Uint8Array(result!.data), t.data, `tile ${t.z}/${t.x}/${t.y}`);
  }
  assert.ok(source.stats.rejected >= 1, 'the tampering host was caught');
  assert.equal(source.getKey(), pkg.rootCid);
});
