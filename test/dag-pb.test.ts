import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as dagPb from '@ipld/dag-pb';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { encodeDirNode, type DirLink } from '../src/dag-pb.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes, rng, sha256Bytes } from './helpers/bytes.ts';

const DIR_DATA = Uint8Array.of(0x08, 0x01);

function referenceEncode(links: DirLink[]): Uint8Array {
  const sorted = [...links].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
  );
  return dagPb.encode({
    Data: DIR_DATA,
    Links: sorted.map((l) => ({
      Name: l.name,
      Hash: CID.decode(l.cidBytes),
      Tsize: l.tsize,
    })),
  });
}

function link(name: string, seed: number, tsize: number): DirLink {
  const codec = seed % 2 === 0 ? 0x55 : 0x70;
  const cid = CID.createV1(codec, Digest.create(0x12, sha256Bytes(deterministicBytes(8, seed))));
  return { name, cidBytes: cid.bytes, tsize };
}

test('byte-identical to @ipld/dag-pb across randomized link sets', () => {
  const names = [
    'map.pmtiles',
    'proofs',
    'metadata.json',
    'a',
    'Z',
    'Noto Sans Regular',
    'näme',
    'z\uE000end', // BMP private-use: UTF-16 sorts it after astral chars
    'z\u{10000}end', // astral: UTF-8 byte order differs from UTF-16 order
    'index.html',
  ];
  const random = rng(99);
  for (let round = 0; round < 25; round++) {
    const pool = [...names].sort(() => random() - 0.5);
    const count = 1 + Math.floor(random() * pool.length);
    const links = pool
      .slice(0, count)
      .map((name, i) =>
        link(name, round * 31 + i, Math.floor(random() * Number.MAX_SAFE_INTEGER)),
      );
    assert.deepEqual(encodeDirNode(links), referenceEncode(links), `round ${round}`);
  }
});

test('tsize varint edge values match the reference encoder', () => {
  for (const tsize of [0, 1, 127, 128, 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const links = [link('x', 1, tsize)];
    assert.deepEqual(encodeDirNode(links), referenceEncode(links), `tsize ${tsize}`);
  }
});

test('an empty link list still yields the canonical empty directory', () => {
  assert.deepEqual(encodeDirNode([]), dagPb.encode({ Data: DIR_DATA, Links: [] }));
});

test('sorts by UTF-8 bytes, not UTF-16 code units', () => {
  // In UTF-8 byte order U+E000 (0xEE…) sorts before U+10000 (0xF0…), but
  // in UTF-16 code units U+E000 sorts after the surrogate lead 0xD800 — the orders
  // disagree, and the canonical block must use UTF-8 order.
  const links = [link('\u{10000}', 1, 1), link('\uE000', 2, 2)];
  assert.deepEqual(encodeDirNode(links), referenceEncode(links));
  assert.deepEqual(encodeDirNode([...links].reverse()), referenceEncode(links));
});

test('duplicate names reject', () => {
  assert.throws(
    () => encodeDirNode([link('same', 1, 1), link('same', 2, 2)]),
    VerificationError,
  );
});

test('invalid tsize rejects', () => {
  for (const tsize of [-1, 0.5, 2 ** 53, NaN]) {
    assert.throws(() => encodeDirNode([link('x', 1, tsize)]), VerificationError, `tsize ${tsize}`);
  }
});
