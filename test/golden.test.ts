// Golden compatibility: fixtures are a REAL published package — built by the
// reference publisher pipeline (ipfs-unixfs-importer + @ipld/dag-pb) from a
// 44,199,060-byte PMTiles world extract — pinned here as bytes. If the
// zero-dependency CID/dag-pb/proof code ever drifts from what real IPFS
// tooling produces, these tests fail. Fixtures: metadata.json, the complete
// proofs/ tree (1 meta + 2 shards), and the first 64 KiB of the archive.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { openMapManifest } from '../src/bootstrap.ts';
import { ProofIndex } from '../src/proof-index.ts';
import { RangeSource } from '../src/range-source.ts';
import { VerifiedSource } from '../src/index.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { rangeFetch } from './helpers/host.ts';

const GOLDEN_ROOT = 'bafybeihnila5l5dabqrbpvaictnce5wop364y5kbc7kfowbnd5mbnpayci';
const MAP_SIZE = 44199060;
const LEAF_COUNT = 2905;
const HEAD_LENGTH = 65536;

const fixture = async (name: string) =>
  new Uint8Array(await readFile(new URL(`./fixtures/golden/${name}`, import.meta.url)));

const files = new Map([
  ['metadata.json', await fixture('metadata.json')],
  ['proofs/meta', await fixture('proofs/meta')],
  ['proofs/0000000000000000', await fixture('proofs/0000000000000000')],
  ['proofs/00000000019537fe', await fixture('proofs/00000000019537fe')],
  ['map.pmtiles', await fixture('map.head.bin')], // first 64 KiB only
]);

test('the real package bootstraps against its root CID', async () => {
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(files) })]);
  const manifest = await openMapManifest(GOLDEN_ROOT, store);
  assert.equal(manifest.mapFile, 'map.pmtiles');
  assert.equal(manifest.mapSize, MAP_SIZE);
  assert.equal(manifest.proofsDir, 'proofs');
  assert.equal(
    manifest.proofsMetaDigest,
    'b0776b07b122eb11d916c51afa57fffee3142a6bd5de11551a57ee34081da1f4',
  );
});

test('the full real proof tree descends, partitions the archive, and counts its leaves', async () => {
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(files) })]);
  const manifest = await openMapManifest(GOLDEN_ROOT, store);
  const index = new ProofIndex(store, {
    dir: manifest.proofsDir,
    metaDigest: manifest.proofsMetaDigest,
    fileSize: manifest.mapSize,
  });
  const leaves = await index.leavesFor(0, MAP_SIZE);
  assert.equal(leaves.length, LEAF_COUNT);
  let expected = 0;
  for (const leaf of leaves) {
    assert.equal(leaf.offset, expected, 'leaves partition the file exactly');
    expected += leaf.length;
  }
  assert.equal(expected, MAP_SIZE);
});

test('real archive bytes verify against the real proofs through the public API', async () => {
  const source = new VerifiedSource({
    rootCid: GOLDEN_ROOT,
    source: '.',
    fetchFn: rangeFetch(files),
  });
  await source.ready();

  // Read the longest whole-leaf prefix inside the 64 KiB head fixture.
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(files) })]);
  const manifest = await openMapManifest(GOLDEN_ROOT, store);
  const index = new ProofIndex(store, {
    dir: manifest.proofsDir,
    metaDigest: manifest.proofsMetaDigest,
    fileSize: manifest.mapSize,
  });
  const head = await index.leavesFor(0, HEAD_LENGTH);
  const whole = head.filter((l) => l.offset + l.length <= HEAD_LENGTH);
  assert.ok(whole.length >= 1, 'the head fixture must contain at least one whole leaf');
  const end = whole[whole.length - 1]!;

  const { data } = await source.getBytes(0, end.offset + end.length);
  const headBytes = files.get('map.pmtiles')!;
  assert.deepEqual(new Uint8Array(data), headBytes.subarray(0, end.offset + end.length));
  assert.ok(source.stats.verified >= whole.length);
  assert.equal(source.stats.rejected, 0);
});
