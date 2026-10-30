// Writes the JSON test vectors the Rust packer's unit tests check against
// (packer/tests/fixtures/). Full-size trees need gigabytes before they reach
// three levels, so these use small fanouts — the UnixFS importer with tiny
// chunks and 3 links per node, and proof trees with tiny meta limits — to
// exercise the same code paths in a few bytes.
//
//   node tools/gen-rust-vectors.ts [out-dir]   (default packer/tests/fixtures)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { decodeDescriptor, encodeDescriptor } from '../packages/anymirror/src/descriptor.ts';
import { encodeBytesHead, encodeUint } from '../packages/anymirror/src/drisl.ts';
import { encodeManifest, type ManifestEntry } from '../packages/anymirror/src/manifest.ts';
import { blake3Bytes, deterministicBytes, sha256Bytes } from '../test/helpers/bytes.ts';
import { box, concat, fragment, header, largeBox, openBox } from '../test/helpers/mp4-writer.ts';
import { assemblePmtiles, encodeDirectory, writePmtilesArchive } from '../test/helpers/pmtiles-writer.ts';
import { encodeMeta } from '../packages/anymirror/src/proof-format.ts';
import {
  buildProofTree,
  choosePmtilesTileGroup,
  isFragmentedMp4,
  mp4Cuts,
  parsePmtiles,
  postOrder,
  RecordingBlockstore,
  type RawLeaf,
} from './pack.ts';

const OUT_DIR = process.argv[2] ?? fileURLToPath(new URL('../packer/tests/fixtures/', import.meta.url));
const FANOUT = 3;
const RAW = 0x55;
const DAG_PB = 0x70;
const DAG_CBOR = 0x71;
const SHA2_256 = 0x12;
const BLAKE3 = 0x1e;
const GiB4 = 2 ** 32;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const cidOf = (code: number, bytes: Uint8Array): CID => CID.createV1(code, Digest.create(SHA2_256, sha256Bytes(bytes)));
const mapCidOf = async (bytes: Uint8Array): Promise<CID> => CID.createV1(RAW, Digest.create(BLAKE3, await blake3Bytes(bytes)));

// ---- UnixFS: balanced layout, raw leaves, blocks in canonical post-order ----

async function unixfsCase(name: string, input: Uint8Array, chunkSize: number) {
  const store = new RecordingBlockstore();
  let root: CID | undefined;
  for await (const entry of importer([{ content: input }], store, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize }),
    layout: balanced({ maxChildrenPerNode: FANOUT }),
  })) root = entry.cid;
  if (root === undefined) throw new Error(`${name}: importer produced no root`);
  const blocks = postOrder(root, store.recorded).map((b) => ({ cid: b.cid.toString(), bytes: hex(b.bytes) }));
  return { name, chunkSize, input: hex(input), root: root.toString(), blocks };
}

async function unixfsVectors() {
  const sizes = [1, 4, 5, 12, 13, 27, 28, 40, 112, 113];
  const cases = [];
  for (const size of sizes) cases.push(await unixfsCase(`size ${size}, chunk 4`, deterministicBytes(size, size), 4));
  cases.push(await unixfsCase('zeros 40, chunk 4 (shared leaves)', new Uint8Array(40), 4));
  cases.push(await unixfsCase('size 0', new Uint8Array(0), 4));
  return {
    description: 'ipfs-unixfs-importer: cidVersion 1, rawLeaves, fixedSize(chunkSize), balanced({ maxChildrenPerNode: 3 }); blocks in DAG post-order, each once',
    maxChildrenPerNode: FANOUT,
    cases,
  };
}

// ---- Proof trees: bands → shards → metas, with small meta limits ----------

// Leaf digests follow a fixed rule so the vectors list only spans.
const leafDigest = (offset: number): Uint8Array => sha256Bytes(encodeU64le(offset));

function encodeU64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

// Consecutive leaves of one length, starting at `start`.
const run = (start: number, count: number, length: number): RawLeaf[] =>
  Array.from({ length: count }, (_, i) => ({ offset: start + i * length, length, digest: leafDigest(start + i * length) }));

function treeCase(name: string, bands: RawLeaf[][], limits: { metaMaxEntries?: number; topMaxEntries?: number; subMetaMaxEntries?: number } = {}) {
  const spans = bands.map((band) => band.map((leaf) => [leaf.offset, leaf.length]));
  try {
    const { files, topMeta } = buildProofTree(bands, limits);
    return { name, ...limits, bands: spans, topMeta: hex(topMeta), files: files.map((f) => ({ path: f.path, content: hex(f.content) })) };
  } catch (err) {
    return { name, ...limits, bands: spans, error: (err as Error).message };
  }
}

function proofTreeVectors() {
  // One leaf of 4 GiB fills a shard by itself (its successor's relative
  // offset would not fit u32), so many shards cost few leaves.
  const big = (start: number, count: number) => run(start * GiB4, count, GiB4);
  return {
    description: 'buildProofTree(bands, limits); leaf digest = sha256(u64le(offset)); files in emission order; defaults: metaMaxEntries 6393, topMaxEntries 1598, subMetaMaxEntries 399',
    cases: [
      treeCase('one band, three leaves', [run(0, 3, 10)]),
      treeCase('1,821 leaves: the shard record cap', [run(0, 1821, 1)]),
      treeCase('u32 relative offset boundary', [[
        { offset: 0, length: 0xffffffff, digest: leafDigest(0) },
        { offset: 0xffffffff, length: 1, digest: leafDigest(0xffffffff) },
        { offset: GiB4, length: 5, digest: leafDigest(GiB4) },
      ]]),
      treeCase('2^31-byte leaves: two per shard', [run(0, 5, 2 ** 31)]),
      treeCase('nested directories, meta cap 3', [big(0, 20)], { metaMaxEntries: 3, topMaxEntries: 4 }),
      treeCase('running top-meta total', [big(0, 2), big(2, 3), big(5, 1)], { metaMaxEntries: 3, topMaxEntries: 4 }),
      treeCase('several bands, some nested', [run(0, 3, 7), big(1, 7), run(8 * GiB4, 2, 3)], { metaMaxEntries: 3, topMaxEntries: 5 }),
      treeCase('too many bands (error)', [big(0, 1), big(1, 1), big(2, 1)], { metaMaxEntries: 3, topMaxEntries: 2 }),
      // Each later non-empty band keeps one top-meta slot.
      treeCase('reservation: [3, 1] nests the first band', [big(0, 3), big(3, 1)], { metaMaxEntries: 3, topMaxEntries: 3 }),
      treeCase('reservation: empty bands are not counted', [big(0, 3), [], big(3, 1), []], { metaMaxEntries: 3, topMaxEntries: 3 }),
      treeCase('reservation: a middle band nests', [big(0, 1), big(1, 2), big(3, 1)], { metaMaxEntries: 3, topMaxEntries: 3 }),
      treeCase('reservation: still too many bands (error)', [big(0, 1), big(1, 1), big(2, 1), big(3, 1)], { metaMaxEntries: 3, topMaxEntries: 3 }),
      // A band too large for the top meta splits into directories listed there.
      treeCase('split: 7 shards into 3, 2, 2', [big(0, 7)], { topMaxEntries: 3, subMetaMaxEntries: 3 }),
      treeCase('split: 8 shards into 3, 3, 2', [big(0, 8)], { topMaxEntries: 3, subMetaMaxEntries: 3 }),
      treeCase('split: an exact multiple', [big(0, 6)], { topMaxEntries: 3, subMetaMaxEntries: 2 }),
      treeCase('split: clamped to the meta limit', [big(0, 7)], { metaMaxEntries: 2, topMaxEntries: 4, subMetaMaxEntries: 3 }),
      treeCase('split: a slot kept for each later band', [big(0, 1), big(1, 7), big(8, 1)], { topMaxEntries: 5, subMetaMaxEntries: 3 }),
      treeCase('split: no room falls back to one directory', [big(0, 1), big(1, 7), big(8, 1)], { topMaxEntries: 4, subMetaMaxEntries: 3 }),
      treeCase('split: no room falls back to a nested directory', [big(0, 9)], { metaMaxEntries: 4, topMaxEntries: 2, subMetaMaxEntries: 2 }),
    ],
  };
}

// ---- Default tile group: the choice against small top-meta limits ---------

// One 11 KiB tile per zoom, z0–z2: a 16 KiB group holds one tile, 32 KiB two
// and 64 KiB all three, so each candidate takes a different shard count and
// each limit below picks the first candidate that fits (1598 is the default).
const TILE = 11 * 1024;
const TOP_LIMITS = [1, 2, 3, 4, 5, 6, 1598];

async function tileGroupCase(name: string, bytes: Uint8Array) {
  const parsed = await parsePmtiles(bytes);
  const choices = TOP_LIMITS.map((topMaxEntries) => ({
    topMaxEntries,
    tileGroup: choosePmtilesTileGroup(parsed, bytes.length, { topMaxEntries }),
  }));
  return { name, archive: hex(bytes), choices };
}

async function tileGroupVectors() {
  const tiles = [0, 1, 2].map((z) => ({ z, x: 0, y: 0, data: deterministicBytes(TILE, z + 1) }));
  // Tile ids 0, 1 and 5 are z0, z1 and z2.
  const leaf = encodeDirectory([0, 1, 5].map((id, i) => ({ id, offset: i * TILE, length: TILE })));
  const root = encodeDirectory([{ id: 0, offset: 0, length: leaf.length, runLength: 0 }]);
  const planet = assemblePmtiles({ root, leaves: leaf, tiles: deterministicBytes(3 * TILE, 4), order: ['root', 'tiles', 'metadata', 'leaves'] });
  return {
    description: 'choosePmtilesTileGroup(parsePmtiles(archive), archive.length, { topMaxEntries }) for each listed limit',
    cases: [
      await tileGroupCase('one tile per zoom, leaf directories', writePmtilesArchive(tiles, { rootEntriesPerLeaf: 1 }).bytes),
      await tileGroupCase('planet layout: metadata and leaf directories after the tile data', planet),
    ],
  };
}

// ---- Fragmented MP4: auto detection and the mp4 profile's leaf cuts --------

function mp4Case(name: string, bytes: Uint8Array) {
  const detected = isFragmentedMp4(bytes);
  try {
    return { name, bytes: hex(bytes), detected, cuts: mp4Cuts(bytes) };
  } catch (err) {
    return { name, bytes: hex(bytes), detected, error: (err as Error).message };
  }
}

function mp4Vectors() {
  const ftyp = box('ftyp', 8);
  const moov = box('moov', 20);
  const init = concat(ftyp, moov, box('sidx', 12));
  const frag = fragment(8, 24);
  // A good init section and fragment, then the malformed box.
  const head = concat(init, frag);
  const [styp, emsg, prft] = ['styp', 'emsg', 'prft'].map((type) => box(type, 4));
  return {
    description: 'isFragmentedMp4(bytes) (the auto profile check) and mp4Cuts(bytes): leaf lengths in file order, or the TS error',
    cases: [
      mp4Case('init, fragments and a trailing mfra', concat(init, frag, fragment(4, 40), box('mfra', 8))),
      mp4Case('no boxes after the last mdat', concat(init, frag, frag)),
      mp4Case('styp, emsg and prft open the first and later fragments', concat(ftyp, moov, styp, emsg, prft, frag, styp, frag, prft, emsg, frag)),
      mp4Case('several mdat boxes per fragment', concat(init, box('moof', 8), box('mdat', 4), box('mdat', 4), box('mdat'), frag)),
      mp4Case('a free box after an mdat opens the next leaf', concat(init, frag, box('free'), frag)),
      mp4Case('hybrid: an mdat before the first moof stays in the init leaf', concat(ftyp, moov, box('mdat', 16), frag)),
      mp4Case('hybrid: segment boxes after that mdat open the first fragment', concat(ftyp, box('mdat', 16), styp, emsg, frag)),
      mp4Case('largesize boxes', concat(init, largeBox('moof', 8), largeBox('mdat', 24), frag)),
      mp4Case('largesize 16: an empty mdat', concat(head, header('mdat', 1, 16n))),
      mp4Case('a size-0 mdat runs to the end', concat(init, box('moof', 8), openBox('mdat', 24))),
      mp4Case('a size-0 box after the last mdat', concat(head, openBox('mfra', 4))),
      mp4Case('a moof first: no init leaf, not detected', concat(frag, frag)),
      mp4Case('segment boxes first: no init leaf, not detected', concat(styp, prft, frag)),
      mp4Case('a moof inside a box is not top-level (error)', concat(ftyp, box('moov', frag))),
      mp4Case('regular MP4 (error)', concat(ftyp, moov, box('mdat', 40))),
      mp4Case('empty (error)', new Uint8Array(0)),
      mp4Case('truncated header (error)', concat(head, new Uint8Array(7))),
      mp4Case('truncated largesize header (error)', concat(head, header('mdat', 1), new Uint8Array(7))),
      ...[2, 7].map((size) => mp4Case(`size ${size} (error)`, concat(head, header('mdat', size), new Uint8Array(8)))),
      mp4Case('largesize 15 (error)', concat(head, header('mdat', 1, 15n))),
      mp4Case('largesize past the end by one (error)', concat(head, header('mdat', 1, 17n))),
      mp4Case('largesize 2^32 + remaining: the high word counts (error)', concat(head, header('mdat', 1, 2n ** 32n + 16n))),
      mp4Case('largesize 2^53 - 1 (error)', concat(head, header('mdat', 1, 2n ** 53n - 1n))),
      mp4Case('largesize 2^53 (error)', concat(head, header('mdat', 1, 2n ** 53n))),
      mp4Case('largesize 2^64 - 1 (error)', concat(head, header('mdat', 1, 2n ** 64n - 1n))),
      mp4Case('size past the end by one (error)', concat(head, header('mdat', 9))),
      mp4Case('size 2^32 - 1 (error)', concat(head, header('mdat', 0xffffffff))),
      mp4Case('a malformed box before the first moof: not detected (error)', concat(ftyp, header('moov', 3), frag)),
      mp4Case('a malformed first box (error)', header('ftyp', 3)),
      mp4Case('a size-0 ftyp: not detected (error)', openBox('ftyp', frag)),
      mp4Case('a truncated ftyp (error)', ftyp.subarray(0, 7)),
    ],
  };
}

// ---- Descriptor, CID, and DRISL integer edges -------------------------------

async function descriptorVectors() {
  const metaOf = (count: number) => buildProofTree([run(0, count, GiB4)]).topMeta;
  const cases = [];
  const mapSizes = [1, 23, 24, 255, 256, 65535, 65536, 0xffffffff, GiB4, Number.MAX_SAFE_INTEGER];
  for (const entries of [1, 5, 7, 1598]) {
    for (const mapSize of entries === 1 ? mapSizes : [mapSizes[2]!]) {
      for (const unixfs of [false, true]) {
        const topMeta = metaOf(entries);
        const mapCid = await mapCidOf(Uint8Array.of(entries, mapSize % 256));
        const unixfsCid = unixfs ? cidOf(DAG_PB, Uint8Array.of(entries)) : undefined;
        const descriptor = encodeDescriptor({ mapCidBytes: mapCid.bytes, ...(unixfsCid ? { unixfsCidBytes: unixfsCid.bytes } : {}), topMeta, mapSize });
        cases.push({
          mapCid: mapCid.toString(),
          ...(unixfsCid ? { unixfsCid: unixfsCid.toString() } : {}),
          topMetaEntries: entries,
          topMetaSha256: hex(sha256Bytes(topMeta)),
          mapSize,
          descriptor: entries > 7 ? undefined : hex(descriptor),
          descriptorSha256: hex(sha256Bytes(descriptor)),
          anchor: cidOf(DAG_CBOR, descriptor).toString(),
        });
      }
    }
  }
  return {
    description: 'encodeDescriptor; topMeta = buildProofTree([N leaves of 2^32 bytes at 0, 2^32, …]).topMeta with the u64le-offset digest rule; descriptor hex omitted when large',
    cases,
  };
}

function cidVectors() {
  return {
    description: 'CIDv1 sha2-256, base32 lower (multibase "b"); bytes = binary CID',
    cases: [new Uint8Array(0), Uint8Array.of(0), new TextEncoder().encode('veritiles'), deterministicBytes(1000, 7)].flatMap((input) =>
      [RAW, DAG_PB, DAG_CBOR].map((code) => {
        const cid = cidOf(code, input);
        return { codec: code, input: hex(input), text: cid.toString(), bytes: hex(cid.bytes) };
      })),
  };
}

function drislVectors() {
  const uints = [0, 1, 23, 24, 255, 256, 65535, 65536, 0xffffffff, GiB4, Number.MAX_SAFE_INTEGER];
  const lengths = [0, 23, 24, 255, 256, 0xffff];
  return {
    description: 'DRISL heads: encodeUint (major 0) and encodeBytesHead (major 2, at most 0xffff)',
    uint: uints.map((value) => ({ value, encoded: hex(encodeUint(value)) })),
    bytesHead: lengths.map((length) => ({ length, encoded: hex(encodeBytesHead(length)) })),
  };
}

// ---- MASL manifest (pack assets): ordering, validation, and caps ----------

function manifestCase(name: string, paths: string[], opts: { contentType?: string; size?: number } = {}) {
  const entries = paths.map((path, i) => {
    const cid = cidOf(RAW, Uint8Array.of(i % 256, i >> 8));
    const src = { codec: RAW, hashCode: SHA2_256, digest: cid.multihash.digest, bytes: cid.bytes };
    return [path, { src, size: opts.size ?? i * 1000, ...(opts.contentType === undefined || i % 2 === 1 ? {} : { contentType: opts.contentType }) }] as [string, ManifestEntry];
  });
  try {
    const manifest = encodeManifest(entries, { withType: true });
    return { name, paths: paths.length > 64 ? undefined : paths, count: paths.length, ...opts, manifest: manifest.length > 2048 ? undefined : hex(manifest), manifestSha256: hex(sha256Bytes(manifest)) };
  } catch (err) {
    return { name, paths: paths.length > 64 ? undefined : paths, count: paths.length, ...opts, error: (err as Error).message };
  }
}

function manifestVectors() {
  const many = (count: number, prefix = '/f') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const deep = (depth: number) => `/${Array.from({ length: depth }, () => 'd').join('/')}`;
  return {
    description: 'encodeManifest(withType); entry i: src = raw CID of [i % 256, i >> 8], size = opts.size ?? i*1000, contentType on even i only; `paths` omitted when long (then `count` and many(count) "/f<i>")',
    cases: [
      manifestCase('one', ['/a']),
      manifestCase('order by encoded length then bytes', ['/b', '/a', '/aa', '/A', '/\u{1F600}', '/\uE000', '/a.txt', '/a/b', `/${'x'.repeat(30)}`, `/${'y'.repeat(200)}/${'z'.repeat(100)}`]),
      manifestCase('content types', ['/a.png', '/b', '/c'], { contentType: 'image/png' }),
      manifestCase('size over 2^32', ['/big'], { size: 2 ** 40 }),
      manifestCase('root path', ['/']),
      manifestCase('empty (error)', []),
      manifestCase('no leading slash (error)', ['a']),
      manifestCase('empty segment (error)', ['/a//b']),
      manifestCase('dot segment (error)', ['/a/./b']),
      manifestCase('dotdot segment (error)', ['/..']),
      manifestCase('NUL segment (error)', ['/a\0b']),
      manifestCase('32 segments', [deep(32)]),
      manifestCase('33 segments (error)', [deep(33)]),
      manifestCase('segment of 255 bytes', [`/${'s'.repeat(255)}`]),
      manifestCase('segment of 256 bytes (error)', [`/${'s'.repeat(256)}`]),
      manifestCase('path of 4096 bytes', [`/${Array.from({ length: 16 }, () => 's'.repeat(255)).join('/')}`]),
      manifestCase('path of 4097 bytes (error)', [`/${Array.from({ length: 16 }, () => 's'.repeat(255)).join('/')}x`]),
      manifestCase('first error in sorted order wins (error)', [`/${'s'.repeat(256)}`, deep(33)]),
      manifestCase('duplicate (error)', ['/a', '/a']),
      manifestCase('content-type 255 bytes', ['/a'], { contentType: 't'.repeat(255) }),
      manifestCase('content-type 256 bytes (error)', ['/a'], { contentType: 't'.repeat(256) }),
      manifestCase('4000 entries', many(4000)),
      manifestCase('over the cap (error)', many(5000)),
      manifestCase('65536 entries (error)', many(65536)),
    ],
  };
}

// ---- decodeDescriptor: the strict reader verify ports ---------------------

function decodeCase(name: string, bytes: Uint8Array) {
  try {
    const d = decodeDescriptor(bytes);
    return { name, descriptor: hex(bytes), mapDigest: hex(d.mapCid.digest), mapSize: d.mapSize, topMeta: hex(d.topMeta) };
  } catch (err) {
    return { name, descriptor: hex(bytes), error: (err as Error).message };
  }
}

async function descriptorDecodeVectors() {
  const digest = (n: number) => new Uint8Array(32).fill(n);
  const topMeta = encodeMeta([{ kind: 0, length: 10, digest: digest(1) }, { kind: 1, length: 5, digest: digest(2) }]);
  const map = (await mapCidOf(Uint8Array.of(1))).bytes;
  const build = (fields: { mapCidBytes?: Uint8Array; unixfsCidBytes?: Uint8Array; topMeta?: Uint8Array; mapSize?: number } = {}) =>
    encodeDescriptor({ mapCidBytes: map, topMeta, mapSize: 15, ...fields });
  const base = build();
  const edit = (bytes: Uint8Array, at: number, value: number) => { const copy = new Uint8Array(bytes); copy[at] = value; return copy; };
  const splice = (bytes: Uint8Array, at: number, remove: number, ...insert: number[]) =>
    Uint8Array.from([...bytes.subarray(0, at), ...insert, ...bytes.subarray(at + remove)]);
  const mapAt = base.indexOf(0x25) + 2; // first CID byte after the tag-42 header
  const metaAt = mapAt + 36 + 5; // the meta byte-string head
  const sizeAt = base.length - 1;
  const cases = [
    decodeCase('canonical', base),
    decodeCase('unixfs raw', build({ unixfsCidBytes: cidOf(RAW, Uint8Array.of(2)).bytes })),
    decodeCase('unixfs dag-pb', build({ unixfsCidBytes: cidOf(DAG_PB, Uint8Array.of(2)).bytes })),
    decodeCase('unixfs dag-cbor', build({ unixfsCidBytes: cidOf(DAG_CBOR, Uint8Array.of(2)).bytes })),
    decodeCase('unixfs sha2-512 code', build({ unixfsCidBytes: edit(cidOf(DAG_PB, Uint8Array.of(2)).bytes, 2, 0x13) })),
    decodeCase('three keys', edit(base, 0, 0xa3)),
    decodeCase('version 2', edit(base, 3, 0x02)),
    decodeCase('version non-canonical', splice(base, 3, 1, 0x18, 0x01)),
    decodeCase('version not a uint', edit(base, 3, 0x20)),
    decodeCase('map codec dag-cbor', edit(base, mapAt + 1, DAG_CBOR)),
    decodeCase('map hash code', edit(base, mapAt + 2, 0x13)),
    decodeCase('map sha2-256', edit(base, mapAt + 2, SHA2_256)),
    decodeCase('map digest length', edit(base, mapAt + 3, 0x1f)),
    decodeCase('map version 0', edit(base, mapAt, 0x00)),
    decodeCase('map non-minimal version', splice(base, mapAt, 1, 0x81, 0x00)),
    decodeCase('meta head non-canonical', splice(base, metaAt, 2, 0x59, 0x00, topMeta.length)),
    decodeCase('meta head 1-byte form', splice(base, metaAt, 2, 0x58, topMeta.length)),
    decodeCase('meta not bytes', edit(base, metaAt, 0x60)),
    decodeCase('meta empty', build({ topMeta: new Uint8Array(0), mapSize: 0 })),
    decodeCase('meta short head', build({ topMeta: topMeta.subarray(0, 23), mapSize: 0 })),
    decodeCase('meta bad kind', build({ topMeta: edit(topMeta, 0, 7) })),
    decodeCase('mapSize covers less', build({ mapSize: 16 })),
    decodeCase('mapSize non-canonical', splice(base, sizeAt, 1, 0x18, 15)),
    decodeCase('mapSize 2^53', splice(base, sizeAt, 1, 0x1b, 0, 0x20, 0, 0, 0, 0, 0, 0)),
    decodeCase('mapSize 2^53 - 1', build({ topMeta: encodeMeta([{ kind: 0, length: Number.MAX_SAFE_INTEGER, digest: digest(1) }]), mapSize: Number.MAX_SAFE_INTEGER })),
    decodeCase('mapSize 2-byte non-canonical', splice(base, sizeAt, 1, 0x19, 0, 15)),
    decodeCase('mapSize 4-byte non-canonical', splice(base, sizeAt, 1, 0x1a, 0, 0, 0, 15)),
    decodeCase('mapSize 8-byte non-canonical', splice(base, sizeAt, 1, 0x1b, 0, 0, 0, 0, 0, 0, 0, 15)),
    decodeCase('mapSize not a uint', edit(base, sizeAt, 0x1c)),
    decodeCase('trailing byte', Uint8Array.from([...base, 0])),
    ...Array.from({ length: base.length }, (_, n) => decodeCase(`truncated to ${n}`, base.subarray(0, n))),
  ];
  return { description: 'decodeDescriptor on the canonical descriptor and mutations of it; error is the TS message', cases };
}

const vectors: Record<string, unknown> = {
  'descriptor-decode.json': await descriptorDecodeVectors(),
  'manifest.json': manifestVectors(),
  'unixfs.json': await unixfsVectors(),
  'proof-tree.json': proofTreeVectors(),
  'tile-group.json': await tileGroupVectors(),
  'mp4.json': mp4Vectors(),
  'descriptor.json': await descriptorVectors(),
  'cid.json': cidVectors(),
  'drisl.json': drislVectors(),
};
await mkdir(OUT_DIR, { recursive: true });
for (const [name, value] of Object.entries(vectors)) {
  await writeFile(join(OUT_DIR, name), `${JSON.stringify(value, null, 1)}\n`);
  console.log(`wrote ${join(OUT_DIR, name)}`);
}
