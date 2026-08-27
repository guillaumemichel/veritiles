// The SPEC §5 examples, executable end to end (PLAN-hints S6). HI-01
// drives the REAL pmtiles reader through a hints-located archive; the rest
// exercise the routing shapes — proof-only node, portable relative-URL mirror,
// and a hostile document steered at a tampering host — over the verified read
// path. Every byte still verifies against the anchor; a hint only says where.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PMTiles } from 'pmtiles';

import { VerifiedFile } from '../src/verified-file.ts';
import { VerifiedSource } from '../src/source.ts';
import { packPmtiles } from '../tools/pack.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { buildPkgFlat } from './helpers/pkg-fixtures.ts';
import { scene } from './helpers/serve-hints.ts';
import { writePmtilesArchive, type TileSpec } from './helpers/pmtiles-writer.ts';

const slice = (b: Uint8Array, o: number, n: number) => b.subarray(o, o + n);

const tiles: TileSpec[] = [
  { z: 0, x: 0, y: 0, data: deterministicBytes(500, 1) },
  { z: 1, x: 0, y: 0, data: deterministicBytes(1200, 2) },
  { z: 1, x: 1, y: 0, data: deterministicBytes(2048, 3) },
  { z: 2, x: 1, y: 2, data: deterministicBytes(3000, 4) },
  { z: 2, x: 3, y: 3, data: deterministicBytes(2600, 5) },
  { z: 3, x: 5, y: 5, data: deterministicBytes(2900, 6) },
];
const archive = writePmtilesArchive(tiles);
const packed = await packPmtiles(archive.bytes, { tileGroupBytes: 0 });
const tileData = (z: number, x: number, y: number) => tiles.find((t) => t.z === z && t.x === x && t.y === y)!.data;

test('HI-01: §H9 self-contained page — proofs on a node, content on cdn-a with cdn-b failover', async () => {
  const PAGE = 'https://app.example/hints.json';
  const NODE = 'https://node.example/world.pmtiles';
  const CDNA = 'https://cdn-a.example/world.pmtiles';
  const CDNB = 'https://cdn-b.example/world.pmtiles';
  let downA = false;
  const { fetchFn, requests } = scene(
    [
      { fileUrl: NODE, bytes: archive.bytes, proofs: packed.proofs },
      { fileUrl: CDNA, bytes: archive.bytes, hooks: { fileStatus: () => (downA ? 404 : undefined) } },
      { fileUrl: CDNB, bytes: archive.bytes },
    ],
    { [PAGE]: { [packed.anchor]: [`${NODE}.proofs`], [packed.mapCid]: [CDNA, CDNB] } },
  );
  const source = new VerifiedSource({ cid: packed.anchor, hints: PAGE, fetchFn });
  const pm = new PMTiles(source);
  const header = await pm.getHeader();
  assert.equal(header.maxZoom, 3);
  const warm = await pm.getZxy(0, 0, 0);
  assert.deepEqual(new Uint8Array(warm!.data), tileData(0, 0, 0));
  assert.equal(requests.some((u) => u === CDNB), false, 'cdn-a serves; cdn-b is only failover');

  // cdn-a goes down: a fresh client reads every content byte from cdn-b, proofs
  // still from the node, and still verifies.
  downA = true;
  requests.length = 0;
  const failover = new VerifiedSource({ cid: packed.anchor, hints: PAGE, fetchFn });
  const got = await new PMTiles(failover).getZxy(0, 0, 0);
  assert.deepEqual(new Uint8Array(got!.data), tileData(0, 0, 0));
  assert.ok(requests.includes(CDNB), 'cdn-a down: failed over to cdn-b');
  assert.equal(failover.stats.rejected, 0);
});

test('HI-02: §H9 proof-only node — {cid, proof} + an in-directory document, full read path', async () => {
  const pkg = await buildPkgFlat();
  const NODE = 'https://node.example/world.pmtiles';
  const CDN = 'https://cdn.example/world.pmtiles';
  const { fetchFn } = scene(
    [{ fileUrl: NODE, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: CDN, bytes: pkg.mapBytes }],
    { [`${NODE}.proofs/hints.json`]: { [pkg.mapCid]: [CDN] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, proof: `${NODE}.proofs`, fetchFn });
  const got = await vf.read(0, pkg.mapBytes.length);
  assert.deepEqual(got, pkg.mapBytes);
});

test('HI-03: §H9 portable mirror — ./ and ../ URLs; remounted under a new origin, same bytes verify', async () => {
  const pkg = await buildPkgFlat();
  // Page doc names only the proof dir (relative); the proof dir's own document
  // names content one level up (../). Both resolve against their own URL.
  const pageDoc = { [pkg.anchor]: ['./world.pmtiles.proofs'] };
  const dirDoc = { [pkg.mapCid]: ['../world.pmtiles'] };

  for (const origin of ['https://origin-a.example/site', 'https://origin-b.example/mirror']) {
    const file = `${origin}/world.pmtiles`;
    const { fetchFn } = scene(
      [{ fileUrl: file, bytes: pkg.mapBytes, proofs: pkg.proofs }],
      { [`${origin}/hints.json`]: pageDoc, [`${file}.proofs/hints.json`]: dirDoc },
    );
    const vf = new VerifiedFile({ cid: pkg.anchor, hints: `${origin}/hints.json`, fetchFn });
    const leaf = pkg.leaves[0]!;
    assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length), origin);
  }
});

test('HI-04: §H8 hostile document steers at a tampering host; the honest mirror serves', async () => {
  const pkg = await buildPkgFlat();
  const NODE = 'https://node.example/world.pmtiles';
  const EVIL = 'https://evil.example/world.pmtiles';
  const HONEST = 'https://honest.example/world.pmtiles';
  const { fetchFn, requests } = scene(
    [
      { fileUrl: NODE, bytes: pkg.mapBytes, proofs: pkg.proofs },
      { fileUrl: EVIL, bytes: pkg.mapBytes, hooks: { tamperRange: (b) => flipByte(b) } },
      { fileUrl: HONEST, bytes: pkg.mapBytes },
    ],
    { 'https://hostile.example/hints.json': { [pkg.anchor]: [`${NODE}.proofs`], [pkg.mapCid]: [EVIL, HONEST] } },
  );
  const vf = new VerifiedFile({ cid: pkg.anchor, hints: 'https://hostile.example/hints.json', fetchFn });
  const leaf = pkg.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(pkg.mapBytes, leaf.offset, leaf.length));
  assert.ok(vf.stats.rejected >= 1, 'the tampering host was caught');
  requests.length = 0;
  const next = pkg.leaves[1]!;
  await vf.read(next.offset, next.length);
  assert.equal(requests.includes(EVIL), false, 'the tampering host is banned, never retried');
});
