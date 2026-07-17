import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { decodeNode, findLink } from '../src/unixfs.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes, rng, sha256Bytes } from './helpers/bytes.ts';
import { buildArtifact } from './helpers/artifact.ts';
import { buildBig, buildDeep, buildEmptyDir, buildSplit, buildTree } from './helpers/fixtures.ts';
import { cidBytes, concatBytes, dirNode, pbLink, pbNode, tagL, tagV, unixfsData, uvarint } from './helpers/protobuf.ts';

const digest = (seed: number) => deterministicBytes(32, seed);
const rawCid = (seed: number) => cidBytes(digest(seed));
const rejects = (bytes: Uint8Array) => assert.throws(() => decodeNode(bytes, 'node'), VerificationError);

async function carBlocks(proof: Uint8Array): Promise<{ cid: CID; bytes: Uint8Array }[]> {
  const reader = await CarReader.fromBytes(proof);
  const out: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const block of reader.blocks()) out.push({ cid: block.cid as unknown as CID, bytes: block.bytes });
  return out;
}

// --- Wire strictness (U-W) ---

test('U-W-01 empty input rejects', () => rejects(new Uint8Array(0)));
test('U-W-02 unknown PBNode tag rejects', () => rejects(tagL(0x1a, new Uint8Array(2))));
test('U-W-03 Data before a Link rejects', () => {
  rejects(concatBytes(tagL(0x0a, unixfsData({ type: 1 })), tagL(0x12, pbLink({ hash: rawCid(1), name: 'a' }))));
});
test('U-W-04 duplicate Data rejects', () => {
  rejects(concatBytes(tagL(0x0a, unixfsData({ type: 1 })), tagL(0x0a, unixfsData({ type: 1 }))));
});
test('U-W-05 missing Data rejects', () => rejects(tagL(0x12, pbLink({ hash: rawCid(1), name: 'a' }))));
test('U-W-06 PBLink without Hash rejects', () => {
  rejects(pbNode([tagL(0x12, new TextEncoder().encode('a'))], unixfsData({ type: 1 })));
});
test('U-W-07 PBLink fields out of order reject', () => {
  const nameFirst = concatBytes(tagL(0x12, new TextEncoder().encode('a')), tagL(0x0a, rawCid(1)));
  rejects(pbNode([nameFirst], unixfsData({ type: 1 })));
  const tsizeFirst = concatBytes(tagV(0x18, 5), tagL(0x0a, rawCid(1)), tagL(0x12, new TextEncoder().encode('a')));
  rejects(pbNode([tsizeFirst], unixfsData({ type: 1 })));
});
test('U-W-08 PBLink duplicate Hash / Name / Tsize reject', () => {
  rejects(pbNode([concatBytes(tagL(0x0a, rawCid(1)), tagL(0x0a, rawCid(2)))], unixfsData({ type: 1 })));
  rejects(pbNode([concatBytes(tagL(0x0a, rawCid(1)), tagL(0x12, Uint8Array.of(97)), tagL(0x12, Uint8Array.of(98)))], unixfsData({ type: 1 })));
  rejects(pbNode([concatBytes(tagL(0x0a, rawCid(1)), tagV(0x18, 1), tagV(0x18, 2))], unixfsData({ type: 1 })));
});
test('U-W-09 unknown PBLink tag rejects', () => {
  rejects(pbNode([concatBytes(tagL(0x0a, rawCid(1)), tagV(0x28, 3))], unixfsData({ type: 1 })));
});
test('U-W-10 UnixFS unknown tag and packed blocksizes reject', () => {
  rejects(pbNode([], concatBytes(tagV(0x08, 1), tagV(0x48, 9)))); // field 9
  rejects(pbNode([pbLink({ hash: rawCid(1) })], concatBytes(tagV(0x08, 2), tagV(0x18, 4), tagL(0x22, uvarint(4))))); // packed blocksizes
});
test('U-W-11 UnixFS fields out of ascending order reject', () => {
  rejects(pbNode([], concatBytes(tagV(0x18, 0), tagV(0x08, 1)))); // filesize before Type
});
test('U-W-12 truncated varint and past-end field reject', () => {
  rejects(Uint8Array.of(0x0a, 0x02, 0x08, 0x80)); // Data field, Type varint truncated (continuation, no next byte)
  rejects(Uint8Array.of(0x0a, 0x7f)); // Data length 127 but no bytes follow
});
test('U-W-13 trailing bytes after the node reject', () => {
  rejects(concatBytes(pbNode([], unixfsData({ type: 1 })), Uint8Array.of(0x00)));
});
test('U-W-14 an over-long varint rejects', () => {
  // Type tag 0x08 followed by ten continuation bytes: past the 2^53 cap.
  rejects(pbNode([], concatBytes(Uint8Array.of(0x08), new Uint8Array(10).fill(0x80), Uint8Array.of(0x01))));
});
test('U-W-15 an invalid-UTF-8 link Name rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1), nameBytes: Uint8Array.of(0xff, 0xfe) })], unixfsData({ type: 1 })));
});

// --- Type gate (U-T) ---

test('U-T-01..05 Raw, Metadata, Symlink, HAMTShard, and missing Type reject', () => {
  for (const type of [0, 3, 4, 5]) rejects(pbNode([], unixfsData({ type })));
  rejects(pbNode([], concatBytes(tagV(0x18, 0)))); // no Type field at all
});

// --- Directory rules (U-D) ---

test('U-D-01 importer dir block decodes to matching names and CIDs', async () => {
  const tree = await buildTree();
  const block = (await carBlocks(tree.proof!))[0]!; // root dir
  const node = decodeNode(block.bytes, 'root');
  assert.equal(node.kind, 'dir');
  const reference = dagPb.decode(block.bytes);
  const got = node.kind === 'dir' ? node.links : [];
  assert.deepEqual(got.map((l) => l.name), reference.Links.map((l) => l.Name));
  for (let i = 0; i < got.length; i++) {
    assert.deepEqual(got[i]!.cid.bytes, reference.Links[i]!.Hash.bytes);
  }
});

test('U-D-02 empty directory decodes to zero links', async () => {
  const dir = await buildEmptyDir();
  const block = (await carBlocks(dir.proof!))[0]!;
  const node = decodeNode(block.bytes, 'dir');
  assert.equal(node.kind, 'dir');
  assert.equal(node.kind === 'dir' ? node.links.length : -1, 0);
});

test('U-D-03 unsorted links reject', () => {
  rejects(dirNode([{ name: 'z', hash: rawCid(1) }, { name: 'a', hash: rawCid(2) }]));
});
test('U-D-04 duplicate names reject', () => {
  rejects(dirNode([{ name: 'a', hash: rawCid(1) }, { name: 'a', hash: rawCid(2) }]));
});
test('U-D-05..08 names with /, NUL, ., .. reject', () => {
  rejects(dirNode([{ name: 'a/b', hash: rawCid(1) }]));
  rejects(pbNode([pbLink({ hash: rawCid(1), nameBytes: Uint8Array.of(97, 0, 98) })], unixfsData({ type: 1 })));
  rejects(dirNode([{ name: '.', hash: rawCid(1) }]));
  rejects(dirNode([{ name: '..', hash: rawCid(1) }]));
});
test('U-D-09 missing or empty Name rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 1 }))); // absent
  rejects(pbNode([pbLink({ hash: rawCid(1), nameBytes: new Uint8Array(0) })], unixfsData({ type: 1 }))); // empty
});
test('U-D-10/11 name 256 bytes rejects; 255 accepted', () => {
  rejects(dirNode([{ name: 'x'.repeat(256), hash: rawCid(1) }]));
  const ok = decodeNode(dirNode([{ name: 'x'.repeat(255), hash: rawCid(1) }]), 'dir');
  assert.equal(ok.kind, 'dir');
});
test('U-D-12 link CID with bad codec/version/hash rejects', () => {
  rejects(dirNode([{ name: 'a', hash: cidBytes(digest(1), 0x71) }])); // dag-cbor
  const v0 = concatBytes(Uint8Array.of(0), Uint8Array.of(0x55, 0x12, 0x20), digest(1)); // version 0
  rejects(pbNode([pbLink({ hash: v0, name: 'a' })], unixfsData({ type: 1 })));
  const sha512 = CID.createV1(0x55, Digest.create(0x13, deterministicBytes(64, 2))).bytes;
  rejects(pbNode([pbLink({ hash: sha512, name: 'a' })], unixfsData({ type: 1 })));
});
test('U-D-13 dir with Data/filesize/blocksizes/hashType/fanout reject each', () => {
  rejects(pbNode([], unixfsData({ type: 1, inlineData: Uint8Array.of(1) })));
  rejects(pbNode([], unixfsData({ type: 1, filesize: 3 })));
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 1, blocksizes: [3] })));
  rejects(pbNode([], unixfsData({ type: 1, hashType: 0 })));
  rejects(pbNode([], unixfsData({ type: 1, fanout: 256 })));
});
test('U-D-14 Tsize absent / present / huge accepted and ignored', () => {
  for (const tsize of [undefined, 5, Number.MAX_SAFE_INTEGER]) {
    const node = decodeNode(pbNode([pbLink({ hash: rawCid(1), name: 'a', tsize })], unixfsData({ type: 1 })), 'dir');
    assert.equal(node.kind, 'dir');
  }
});
test('U-D-15 mode / mtime accepted and ignored', () => {
  const node = decodeNode(pbNode([pbLink({ hash: rawCid(1), name: 'a' })], unixfsData({ type: 1, mode: 0o644, mtime: uvarint(1) })), 'dir');
  assert.equal(node.kind, 'dir');
});
test('U-D-16 names a, z, é sort by UTF-8 bytes; findLink hits and misses', () => {
  const node = decodeNode(
    dirNode([
      { name: 'a', hash: rawCid(1) },
      { name: 'z', hash: rawCid(2) },
      { name: 'é', hash: rawCid(3) },
    ]),
    'dir',
  );
  assert.equal(node.kind, 'dir');
  const links = node.kind === 'dir' ? node.links : [];
  assert.deepEqual(links.map((l) => l.name), ['a', 'z', 'é']); // é (0xc3 0xa9) sorts after z (0x7a)
  assert.equal(findLink(links, 'a'), 0);
  assert.equal(findLink(links, 'z'), 1);
  assert.equal(findLink(links, 'é'), 2);
  assert.equal(findLink(links, 'b'), -1);
});

// --- File rules (U-F) ---

test('U-F-01 importer File node decodes to matching filesize and parts', async () => {
  const big = await buildBig();
  const block = (await carBlocks(big.proof!))[0]!; // File node
  const node = decodeNode(block.bytes, 'file');
  assert.equal(node.kind, 'file');
  const reference = dagPb.decode(block.bytes);
  const unix = UnixFS.unmarshal(reference.Data!);
  if (node.kind !== 'file') return;
  assert.equal(node.filesize, Number(unix.fileSize()));
  assert.deepEqual(node.parts.map((p) => p.blocksize), unix.blockSizes.map(Number));
  assert.equal(node.parts.length, reference.Links.length);
});

test('U-F-02 zero links reject', () => rejects(pbNode([], unixfsData({ type: 2, filesize: 0 }))));
test('U-F-03 a named link rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1), name: 'x' })], unixfsData({ type: 2, filesize: 4, blocksizes: [4] })));
});
test('U-F-04 blocksizes count ≠ link count reject (both directions)', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 8, blocksizes: [4, 4] })));
  rejects(pbNode([pbLink({ hash: rawCid(1) }), pbLink({ hash: rawCid(2) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4] })));
});
test('U-F-05 a blocksize of 0 rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 0, blocksizes: [0] })));
});
test('U-F-06 missing filesize rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, blocksizes: [4] })));
});
test('U-F-07 filesize ≠ sum of blocksizes rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 5, blocksizes: [4] })));
});
test('U-F-08 filesize or blocksize ≥ 2^53 rejects', () => {
  const big = 9007199254740992n; // 2^53
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: big, blocksizes: [4] })));
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 4, blocksizes: [big] })));
});
test('U-F-09 inline Data rejects', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, inlineData: Uint8Array.of(1), filesize: 4, blocksizes: [4] })));
});
test('U-F-10 hashType / fanout present reject each', () => {
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4], hashType: 0 })));
  rejects(pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4], fanout: 8 })));
});
test('U-F-11 link CID with car / dag-cbor codec rejects', () => {
  rejects(pbNode([pbLink({ hash: cidBytes(digest(1), 0x0202) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4] })));
  rejects(pbNode([pbLink({ hash: cidBytes(digest(1), 0x71) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4] })));
});
test('U-F-12 mode / mtime on a file accepted and ignored', () => {
  const node = decodeNode(
    pbNode([pbLink({ hash: rawCid(1) })], unixfsData({ type: 2, filesize: 4, blocksizes: [4], mode: 0o644, mtime: uvarint(1) })),
    'file',
  );
  assert.equal(node.kind, 'file');
});

// --- Differential (U-X) ---

test('U-X-02 every dag-pb block of the built fixtures decodes', async () => {
  for (const build of [buildTree, buildBig, buildSplit, buildDeep]) {
    const art = await build();
    for (const block of await carBlocks(art.proof!)) {
      assert.doesNotThrow(() => decodeNode(block.bytes, 'block'));
    }
  }
});

test('U-X-01 randomized trees decode identically to the reference importer', async () => {
  const seed = 0x51ce;
  const random = rng(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const alphabet = ['a', 'b', 'é', 'Z', '9', 'ρ', '文'];
  const name = () => {
    let s = '';
    for (let i = 0, n = 1 + pick(5); i < n; i++) s += alphabet[pick(alphabet.length)];
    return s === '.' || s === '..' ? `${s}x` : s;
  };

  for (let iter = 0; iter < 30; iter++) {
    const used = new Set<string>();
    const entries: { path: string; bytes: Uint8Array }[] = [];
    for (let i = 0, n = 1 + pick(20); i < n; i++) {
      const depth = pick(3);
      let path = '';
      for (let d = 0; d <= depth; d++) path += (d ? '/' : '') + name();
      if (used.has(path)) continue;
      used.add(path);
      entries.push({ path, bytes: deterministicBytes(pick(3) * 1024, iter * 100 + i + 1) });
    }
    if (entries.length === 0) continue;

    const art = await buildArtifact(entries, { chunkSize: 1024 });
    for (const block of await carBlocks(art.proof!)) {
      const node = decodeNode(block.bytes, `iter ${iter}`);
      const reference = dagPb.decode(block.bytes);
      const unix = UnixFS.unmarshal(reference.Data!);
      if (node.kind === 'dir') {
        assert.equal(unix.type, 'directory');
        assert.deepEqual(node.links.map((l) => l.name), reference.Links.map((l) => l.Name));
        for (const link of node.links) assert.notEqual(findLink(node.links, link.name), -1);
        assert.equal(findLink(node.links, ' missing'), -1);
      } else {
        assert.equal(unix.type, 'file');
        assert.equal(node.filesize, Number(unix.fileSize()));
        assert.deepEqual(node.parts.map((p) => p.blocksize), unix.blockSizes.map(Number));
      }
    }
  }
});

// A crafted-reject counterpart to F-08: guard that sha256 of a section body is
// what the CID commits to — used indirectly here to confirm helpers align.
test('helper cidBytes matches multiformats digest', () => {
  const d = digest(9);
  assert.deepEqual(cidBytes(d), CID.createV1(0x55, Digest.create(0x12, d)).bytes);
  assert.deepEqual(sha256Bytes(new Uint8Array(0)).length, 32);
});
