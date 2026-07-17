import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';

import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { sha256Hex } from './helpers/bytes.ts';
import {
  buildBig,
  buildDeep,
  buildEmptyDir,
  buildRaw,
  buildRawEmpty,
  buildRawMax,
  buildSplit,
  buildTree,
  TREE_ENTRIES,
} from './helpers/fixtures.ts';

// The spec A5 header template (spaces cosmetic): 18-byte prefix, 32-byte root
// digest, 9-byte suffix.
const HEADER_PREFIX = Uint8Array.of(
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
);
const HEADER_SUFFIX = Uint8Array.of(0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01);

const codecOf = (cidText: string): number => CID.parse(cidText).code;

// Ordered {cid, bytes} sections of a proof CAR, via the reference reader.
async function sections(proof: Uint8Array): Promise<{ cid: CID; bytes: Uint8Array }[]> {
  const reader = await CarReader.fromBytes(proof);
  const out: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const block of reader.blocks()) out.push({ cid: block.cid as unknown as CID, bytes: block.bytes });
  return out;
}

// Expected canonical order: DFS from root over dag-pb links, parents first.
function canonicalOrder(blocks: Map<string, Uint8Array>, root: CID): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (cid: CID): void => {
    if (cid.code !== dagPb.code || seen.has(cid.toString())) return;
    seen.add(cid.toString());
    const bytes = blocks.get(cid.toString());
    if (bytes === undefined) return;
    order.push(cid.toString());
    for (const link of dagPb.decode(bytes).Links) walk(link.Hash);
  };
  walk(root);
  return order;
}

test('F-01 FIX-TREE frozen root and anchor', async () => {
  const tree = await buildTree();
  assert.equal(tree.rootCid, 'bafybeie24khnywmxigb6u6n2zgkpkogbq7nus6lpelitvyax3laegikdtq');
  assert.equal(tree.anchor, 'bagbaieraxrfy45tgtwpwp6wbbzzvoo3jaw77snf2vjfzjctmpt3uozbai2na');
});

test('F-02 raw artifacts: anchor codec raw, no proof', async () => {
  for (const build of [buildRaw, buildRawMax]) {
    const art = await build();
    assert.equal(codecOf(art.anchor), 0x55);
    assert.equal(art.proof, undefined);
    assert.equal(art.rootCid, art.anchor);
  }
});

test('F-03 FIX-SPLIT / FIX-BIG: car anchor, FIX-BIG frozen with one section', async () => {
  const split = await buildSplit();
  assert.equal(codecOf(split.anchor), 0x0202);
  assert.ok(split.anchor.startsWith('bagbaiera'));

  const big = await buildBig();
  assert.equal(codecOf(big.anchor), 0x0202);
  assert.equal(big.anchor, 'bagbaiera2ptgueevfkhmpj2z3njoqqtuj6yrezqbnhaz36l6xj5kl2qjuyea');
  assert.equal(big.proof!.length, 255);
  assert.equal((await sections(big.proof!)).length, 1);
});

test('F-04 canonical section order = DFS parents-first, dir links in name order', async () => {
  const tree = await buildTree();
  const secs = await sections(tree.proof!);
  const blocks = new Map(secs.map((s) => [s.cid.toString(), s.bytes]));
  const expected = canonicalOrder(blocks, CID.parse(tree.rootCid));
  assert.deepEqual(
    secs.map((s) => s.cid.toString()),
    expected,
  );
  // Three dag-pb blocks: root dir, then subdirs in name order.
  assert.equal(secs.length, 3);
  assert.equal(secs[0]!.cid.toString(), tree.rootCid);
});

test('F-05 determinism: two builds byte-identical', async () => {
  const a = await buildArtifact(TREE_ENTRIES);
  const b = await buildArtifact(TREE_ENTRIES);
  assert.equal(a.anchor, b.anchor);
  assert.deepEqual(a.proof, b.proof);
});

test('F-06 header differential: first 59 bytes == template', async () => {
  for (const build of [buildBig, buildTree]) {
    const art = await build();
    const digest = CID.parse(art.rootCid).multihash.digest;
    const template = new Uint8Array(59);
    template.set(HEADER_PREFIX, 0);
    template.set(digest, 18);
    template.set(HEADER_SUFFIX, 50);
    assert.deepEqual(art.proof!.subarray(0, 59), template);
  }
});

test('F-07 serveArtifact contract: routes, ordering, hooks', async () => {
  const tree = await buildTree();
  const server = serveArtifact([{ base: 'https://h/fonts', fixture: tree }]);

  const glyphUrl = 'https://h/fonts/Noto%20Sans%20Regular/0-255.pbf';
  const glyph = new Uint8Array(await (await server.fetch(glyphUrl)).arrayBuffer());
  assert.equal(sha256Hex(glyph), sha256Hex(TREE_ENTRIES[1]!.bytes));

  const proofRes = await server.fetch('https://h/fonts.car');
  assert.equal(new Uint8Array(await proofRes.arrayBuffer()).length, tree.proof!.length);
  assert.deepEqual(server.requests, [glyphUrl, 'https://h/fonts.car']);

  // tamper hook mutates a chosen response.
  const tampered = serveArtifact([
    { base: 'https://h/fonts', fixture: tree, hooks: { tamper: (_url, b) => Uint8Array.of(...b.subarray(0, b.length - 1), b[0]! ^ 0xff) } },
  ]);
  const dirty = new Uint8Array(await (await tampered.fetch(glyphUrl)).arrayBuffer());
  assert.notEqual(sha256Hex(dirty), sha256Hex(TREE_ENTRIES[1]!.bytes));

  // status hook forces 404.
  const failing = serveArtifact([{ base: 'https://h/fonts', fixture: tree, hooks: { status: () => 404 } }]);
  assert.equal((await failing.fetch(glyphUrl)).status, 404);

  // dropProof 404s only the .car.
  const noProof = serveArtifact([{ base: 'https://h/fonts', fixture: tree, hooks: { dropProof: true } }]);
  assert.equal((await noProof.fetch('https://h/fonts.car')).status, 404);
  assert.equal((await noProof.fetch(glyphUrl)).status, 200);
});

test('F-08 FIX-DEEP: more than one File node, depth ≥ 9', async () => {
  const deep = await buildDeep();
  const secs = await sections(deep.proof!);
  const blocks = new Map(secs.map((s) => [s.cid.toString(), s.bytes]));
  let fileNodes = 0;
  for (const s of secs) {
    if (UnixFS.unmarshal(dagPb.decode(s.bytes).Data!).type === 'file') fileNodes++;
  }
  assert.ok(fileNodes > 1, `expected > 1 File node, got ${fileNodes}`);

  const depth = (cid: CID): number => {
    if (cid.code !== dagPb.code) return 0;
    const bytes = blocks.get(cid.toString());
    if (bytes === undefined) return 0;
    let max = 0;
    for (const link of dagPb.decode(bytes).Links) max = Math.max(max, depth(link.Hash));
    return 1 + max;
  };
  assert.ok(depth(CID.parse(deep.rootCid)) >= 9);
});

test('F-09 builder cap: an oversized structure throws', async () => {
  const entries = [];
  for (let d = 0; d < 30; d++) {
    for (let e = 0; e < 300; e++) {
      entries.push({ path: `d${d}/f${e}`, bytes: Uint8Array.of(d, e & 0xff) });
    }
  }
  await assert.rejects(buildArtifact(entries), /over the 262144 cap|sharded/);
});

test('FIX-RAW-EMPTY builds a raw anchor of empty bytes', async () => {
  const empty = await buildRawEmpty();
  assert.equal(codecOf(empty.anchor), 0x55);
  assert.equal(empty.proof, undefined);
  assert.deepEqual(empty.files.get(''), new Uint8Array(0));
});

test('FIX-EMPTY-DIR builds a directory root with zero links', async () => {
  const dir = await buildEmptyDir();
  assert.equal(codecOf(dir.rootCid), dagPb.code);
  assert.equal(codecOf(dir.anchor), 0x0202);
  const secs = await sections(dir.proof!);
  assert.equal(secs.length, 1);
  assert.equal(dagPb.decode(secs[0]!.bytes).Links.length, 0);
});
