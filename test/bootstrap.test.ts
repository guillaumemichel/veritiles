import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { openMapManifest } from '../src/bootstrap.ts';
import { RangeSource } from '../src/range-source.ts';
import { VerificationError } from '../src/verify.ts';
import { VerifiedStore } from '../src/verified-store.ts';
import { deterministicBytes, flipByte, sha256Bytes } from './helpers/bytes.ts';
import { rangeFetch } from './helpers/host.ts';
import { buildMapPackage } from './helpers/package.ts';

const fixture = await buildMapPackage({
  mapBytes: deterministicBytes(4000, 30),
  cuts: [1000, 2000, 1000],
});

function storeOver(files: Map<string, Uint8Array>) {
  return new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(files) })]);
}

// Serves handcrafted metadata.json bytes; for schema-validation tests that
// reject before any reconstruction happens.
const stubStore = (manifest: unknown) => ({
  fetchUnverified: async () => new TextEncoder().encode(JSON.stringify(manifest)),
});

const parseManifest = () =>
  JSON.parse(new TextDecoder().decode(fixture.files.get('metadata.json')!));

test('metadata.json alone reconstructs the root CID and yields the manifest', async () => {
  const manifest = await openMapManifest(fixture.rootCid, storeOver(fixture.files));
  assert.equal(manifest.mapFile, 'map.pmtiles');
  assert.equal(manifest.mapSize, 4000);
  assert.equal(manifest.proofsDir, 'proofs');
  assert.match(manifest.proofsMetaDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.children.length, 2);
});

test('any tampered metadata.json byte fails reconstruction', async () => {
  for (const index of [0, 100, 200]) {
    const files = new Map(fixture.files);
    files.set('metadata.json', flipByte(fixture.files.get('metadata.json')!, index));
    await assert.rejects(
      openMapManifest(fixture.rootCid, storeOver(files)),
      (err: Error) => err.name === 'VerificationError' || err instanceof AggregateError,
      `byte ${index}`,
    );
  }
});

test('a different root CID rejects the same metadata.json', async () => {
  // A valid dag-pb CID that is not this package's root: the map file child.
  await assert.rejects(
    openMapManifest(fixture.mapCid, storeOver(fixture.files)),
    /does not reconstruct/,
  );
});

test('a raw (non-dag-pb) root CID is rejected up front', async () => {
  const raw = CID.createV1(0x55, Digest.create(0x12, sha256Bytes(new Uint8Array(3)))).toString();
  await assert.rejects(openMapManifest(raw, storeOver(fixture.files)), /must be dag-pb/);
});

test('non-base32 and CIDv0 roots are rejected up front', async () => {
  await assert.rejects(
    openMapManifest('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', storeOver(fixture.files)),
    /not multibase base32/,
  );
  await assert.rejects(openMapManifest('not a cid', storeOver(fixture.files)), VerificationError);
});

test('astral and private-use child names reconstruct canonically', async () => {
  // UTF-16 string order and UTF-8 byte order disagree for these two names;
  // an honest package containing them must still verify (the encoder sorts
  // by UTF-8 bytes, dag-pb's canonical order).
  const exotic = await buildMapPackage({
    mapBytes: deterministicBytes(1000, 77),
    cuts: [1000],
    extraChildren: [
      { name: '\uE000', tsize: 1 },
      { name: '\u{10000}', tsize: 2 },
    ],
  });
  const manifest = await openMapManifest(exotic.rootCid, storeOver(exotic.files));
  assert.equal(manifest.children.length, 4);
});

test('a font-package manifest is rejected (no map section)', async () => {
  const good = parseManifest();
  const manifest = { ...good, map: undefined, proofs: undefined, fonts: { dir: 'fonts', proofs: 'proofs' } };
  await assert.rejects(
    openMapManifest(fixture.rootCid, stubStore(manifest)),
    /invalid name for map.file/,
  );
});

test('garbage JSON is rejected', async () => {
  const files = new Map(fixture.files);
  files.set('metadata.json', new TextEncoder().encode('not json'));
  await assert.rejects(
    openMapManifest(fixture.rootCid, storeOver(files)),
    /not valid UTF-8 JSON/,
  );
});

test('non-UTF-8 metadata bytes are rejected', async () => {
  const files = new Map(fixture.files);
  files.set('metadata.json', Uint8Array.of(0xff, 0xfe, 0x7b, 0x7d));
  await assert.rejects(
    openMapManifest(fixture.rootCid, storeOver(files)),
    /not valid UTF-8 JSON/,
  );
});

test('schema violations are rejected before reconstruction', async () => {
  const good = parseManifest();
  const cases: [unknown, RegExp][] = [
    [null, /formatVersion/],
    ['manifest', /formatVersion/],
    [{ ...good, formatVersion: 99 }, /formatVersion/],
    [{ ...good, hash: 'sha3-512' }, /unsupported hash/],
    [{ ...good, map: { ...good.map, size: -1 } }, /invalid size/],
    [{ ...good, map: { ...good.map, size: 2 ** 53 } }, /invalid size/],
    [{ ...good, map: { ...good.map, file: 'a/b' } }, /invalid name/],
    [{ ...good, map: { ...good.map, file: '..' } }, /invalid name/],
    [{ ...good, map: { ...good.map, file: 'x'.repeat(256) } }, /invalid name/],
    [{ ...good, proofs: { ...good.proofs, metaDigest: 'zz' } }, /metaDigest/],
    [{ ...good, proofs: { ...good.proofs, dir: '' } }, /invalid name/],
    [{ ...good, children: [] }, /children/],
    [{ ...good, children: 'nope' }, /children/],
    [{ ...good, children: good.children.slice(0, 1) }, /missing entry/],
    [
      {
        ...good,
        children: [
          ...good.children,
          { name: 'metadata.json', cid: good.children[0].cid, tsize: 1 },
        ],
      },
      /must not list metadata.json/,
    ],
    [
      { ...good, children: [...good.children, { ...good.children[0] }] },
      /duplicate child/,
    ],
    [
      { ...good, children: good.children.map((c: { cid: string }) => ({ ...c, cid: 'not-a-cid' })) },
      /CID is not multibase base32/,
    ],
    [
      { ...good, children: Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, cid: good.children[0].cid, tsize: 0 })) },
      /children/,
    ],
  ];
  for (const [manifest, expected] of cases) {
    await assert.rejects(
      openMapManifest(fixture.rootCid, stubStore(manifest)),
      expected,
      JSON.stringify(manifest)?.slice(0, 80),
    );
  }
});

test('every child value is load-bearing: altering any breaks reconstruction', async () => {
  const good = parseManifest();
  const mutations: ((m: { children: { tsize: number; cid: string }[] }) => void)[] = [
    (m) => (m.children[0]!.tsize += 1),
    (m) => (m.children[1]!.cid = m.children[0]!.cid),
    (m) => m.children.splice(1, 1),
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(good);
    mutate(manifest);
    await assert.rejects(
      openMapManifest(fixture.rootCid, stubStore(manifest)),
      VerificationError,
    );
  }
});

test('oversized metadata.json is rejected by the read cap', async () => {
  const files = new Map(fixture.files);
  files.set('metadata.json', new Uint8Array(1024 * 1024 + 1));
  await assert.rejects(openMapManifest(fixture.rootCid, storeOver(files)), AggregateError);
});
