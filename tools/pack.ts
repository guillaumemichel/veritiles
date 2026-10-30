// The veritiles packer is a repository development tool. It is not included
// in the published library package.
// Turns a file into a verified pair: its raw whole-file BLAKE3 CID and a dag-cbor
// descriptor plus a meta/shard tree of static files (PLAN-shards §3).
// `verify` opens a real VerifiedFile over the emitted package and spot-reads
// random ranges.
//
//   npm run pack -- map.pmtiles                      → ./map.pmtiles.proofs/
//   npm run pack -- map.pmtiles --tile-group 1MiB
//   npm run pack -- verify --cid b… --file <path> --proofs <dir>

import { CarWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';
import { createBLAKE3 } from 'hash-wasm';
import { bytesToHeader, Compression, SharedPromiseCache, type Entry, type Header, type Source } from 'pmtiles';

import { encodeDescriptor } from '../packages/anymirror/src/descriptor.ts';
import { encodeManifest } from '../packages/anymirror/src/manifest.ts';
import { DESCRIPTOR_CAP } from '../packages/anymirror/src/limits.ts';
import {
  encodeMeta,
  encodeShard,
  KIND_DIR,
  KIND_SHARD,
  MAX_SHARD_RECORDS,
  META_RECORD_SIZE,
  shardName,
} from '../packages/anymirror/src/proof-format.ts';
import { VerifiedFile } from '../packages/anymirror/src/verified-file.ts';

const RAW_CODE = 0x55;
const SHA2_256 = 0x12;
const BLAKE3 = 0x1e; // the map only: no client recomputes it (SPEC §2.1)
const DAG_CBOR_CODE = 0x71;
const DAG_PB_CODE = 0x70;
const META_FILE_CAP = 256 * 1024;
const META_MAX_ENTRIES = Math.floor(META_FILE_CAP / META_RECORD_SIZE);
// The top meta is a descriptor byte string, whose DRISL head carries at most
// a 2-byte length.
const TOP_META_MAX_ENTRIES = Math.floor(0xffff / META_RECORD_SIZE);
// A band too large for the top meta splits into directories of at most this
// many shards: 399 records fit in 16 KiB, so the first view into the band
// waits on a small meta, while the top meta grows by only a few entries.
const SUB_META_MAX_ENTRIES = 399;
const MAX_REL_OFFSET = 0xffffffff; // shard records hold u32 relative offsets
const DEFAULT_CHUNK = 1 << 20; // 1 MiB — the `fixed` profile default
// The `pmtiles` profile's default tile group is the smallest of these that
// keeps every shard in the top meta (choosePmtilesTileGroup): a reader then
// reaches any shard from the descriptor alone, while small groups keep the
// bytes fetched per tile close to the tile. Larger groups would keep more
// archives flat but fetch more unwanted bytes, so the choice stops at 64 KiB.
const TILE_GROUP_CANDIDATES = [16 * 1024, 32 * 1024, 64 * 1024];
const PMTILES_HEADER_SIZE = 127;
const PMTILES_PROBE = 16384;
const PMTILES_MAGIC = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);
// Bounds memory against decompression bombs and entry amplification.
const PMTILES_BLOCK_CAP = 256 * 1024 * 1024;
const PMTILES_MAX_TILE_ENTRIES = 2 ** 30;
const ZSTD_MAGIC = 0xfd2fb528;

export interface RawLeaf {
  offset: number;
  length: number;
  digest: Uint8Array;
}

export interface ProofFile {
  path: string;
  content: Uint8Array;
}

export interface Packed {
  /** The veritiles anchor: CIDv1(dag-cbor, sha2-256(descriptor)). */
  anchor: string;
  /** The content's raw whole-file BLAKE3 CID. */
  mapCid: string;
  /** Optional standard UnixFS root for external IPFS pinning. */
  unixfsCid?: string;
  descriptor: Uint8Array;
  /** Proof-base-relative files: 'root', '{hex}', '{hex}/meta', … */
  proofs: Map<string, Uint8Array>;
  leafCount: number;
  /** Every block in the optional UnixFS DAG, suitable for `ipfs dag import`. */
  fullCar?: Uint8Array;
  /** The byte lengths emitted by a content-aware profile, when applicable. */
  cuts?: number[];
  /** The `pmtiles` profile's tile group budget, chosen or explicit. */
  tileGroupBytes?: number;
}

export interface PmtilesOptions {
  /**
   * Maximum bytes in one tile-data leaf. Defaults to the smallest of 16, 32
   * and 64 KiB that keeps every shard in the top meta, else 64 KiB. Use 0
   * for one tile per leaf.
   */
  tileGroupBytes?: number;
  /** Alias for the CLI's `--tile-group` option. */
  tileGroup?: number;
  /** Add an independent, standard 256 KiB UnixFS representation. */
  unixfs?: boolean;
}

export interface ParsedPmtiles {
  header: Header;
  metadata: Uint8Array;
  rootDirectory: Entry[];
  leafDirectories: { offset: number; length: number; entries: Entry[] }[];
  tileRanges: { offset: number; length: number; tileId: number }[];
  sectionBoundaries: number[];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

// Fixed-size chunking (the `fixed` profile). `fixedSize({ chunkSize: N })` is
// byte-identical to kubo `ipfs add --cid-version 1 --chunker size-N`.
export async function packFixed(bytes: Uint8Array, opts: { chunkSize?: number; unixfs?: boolean } = {}): Promise<Packed> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error(`bad chunk size: ${chunkSize}`);
  return packWithChunker(bytes, fixedSize({ chunkSize }), { unixfs: opts.unixfs });
}

/** Pack a PMTiles v3 archive using the profile from PLAN-shards §3 (zoom-shaped). */
export async function packPmtiles(bytes: Uint8Array, opts: PmtilesOptions = {}): Promise<Packed> {
  const parsed = await parsePmtiles(bytes);
  const tileGroupBytes = tileGroupBudget(parsed, bytes.length, opts);
  const groups = groupedTileRanges(parsed.tileRanges, tileGroupBytes);
  const cuts = cutLengths(pmtilesCutPoints(bytes.length, parsed, groups));
  const packed = await packWithChunker(bytes, cutChunker(cuts), {
    cuts,
    unixfs: opts.unixfs,
    bands: (leaves) => pmtilesBands(leaves, parsed.header, groups),
  });
  return { ...packed, tileGroupBytes };
}

// An explicit budget is checked; without one, it is chosen from the archive.
function tileGroupBudget(parsed: ParsedPmtiles, fileLength: number, opts: PmtilesOptions): number {
  const budget = opts.tileGroupBytes ?? opts.tileGroup;
  if (budget === undefined) return choosePmtilesTileGroup(parsed, fileLength);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error(`bad tile grouping budget: ${budget}`);
  return budget;
}

/**
 * The default tile group for a parsed archive: the first of
 * TILE_GROUP_CANDIDATES whose shards all fit in the top meta, so that every
 * band is inlined there; the largest when none does. It counts shards and
 * hashes nothing. `topMaxEntries` is a test hook.
 */
export function choosePmtilesTileGroup(
  parsed: ParsedPmtiles,
  fileLength: number,
  { topMaxEntries = TOP_META_MAX_ENTRIES }: { topMaxEntries?: number } = {},
): number {
  const flat = TILE_GROUP_CANDIDATES.find((budget) => shardTotal(parsed, fileLength, budget) <= topMaxEntries);
  return flat ?? TILE_GROUP_CANDIDATES.at(-1)!;
}

// buildProofTree inlines every band exactly when the shards of all bands fit
// in the top meta together: each band has a shard, so the slots kept for
// later bands are then free, and no band can outgrow a meta (the top meta's
// 1,598 entries are fewer than a meta's 6,393).
function shardTotal(parsed: ParsedPmtiles, fileLength: number, budget: number): number {
  const groups = groupedTileRanges(parsed.tileRanges, budget);
  // A leaf starts at every cut point but the last, the end of the file.
  const leaves = pmtilesCutPoints(fileLength, parsed, groups).slice(0, -1).map((offset) => ({ offset }));
  return pmtilesBands(leaves, parsed.header, groups).reduce((total, band) => total + shardRanges(band).length, 0);
}

/** Pack a fragmented MP4: one leaf per fragment, after one for the init section. */
export async function packMp4(bytes: Uint8Array, opts: { unixfs?: boolean } = {}): Promise<Packed> {
  const cuts = mp4Cuts(bytes);
  return packWithChunker(bytes, cutChunker(cuts), { cuts, unixfs: opts.unixfs });
}

const PROFILES = ['auto', 'fixed', 'pmtiles', 'mp4'] as const;
export type PackProfile = (typeof PROFILES)[number];

export interface PackOptions extends PmtilesOptions {
  profile?: PackProfile;
  chunkSize?: number;
}

/** Select the profile by content — PMTiles v3, then fragmented MP4 — unless the caller overrides it. */
export async function pack(bytes: Uint8Array, opts: PackOptions = {}): Promise<Packed> {
  const requested = opts.profile ?? 'auto';
  if (!(PROFILES as readonly string[]).includes(requested)) throw new Error(`unknown profile: ${requested}`);
  const profile = requested === 'auto' ? detectProfile(bytes) : requested;
  // An option the chosen profile ignores is a mistake, not a no-op.
  if (profile !== 'fixed' && opts.chunkSize !== undefined) throw new Error('--chunk applies only to the fixed profile');
  if (profile !== 'pmtiles' && (opts.tileGroupBytes ?? opts.tileGroup) !== undefined) {
    throw new Error('--tile-group applies only to the pmtiles profile');
  }
  if (profile === 'pmtiles') return packPmtiles(bytes, opts);
  if (profile === 'mp4') return packMp4(bytes, { unixfs: opts.unixfs });
  return packFixed(bytes, { chunkSize: opts.chunkSize, unixfs: opts.unixfs });
}

function detectProfile(bytes: Uint8Array): Exclude<PackProfile, 'auto'> {
  if (isPmtilesV3(bytes)) return 'pmtiles';
  return isFragmentedMp4(bytes) ? 'mp4' : 'fixed';
}

async function packWithChunker(
  bytes: Uint8Array,
  chunker: (source: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>,
  opts: { cuts?: number[]; bands?: (leaves: RawLeaf[]) => RawLeaf[][]; unixfs?: boolean },
): Promise<Packed> {
  const leaves: RawLeaf[] = [];
  let offset = 0;
  async function* source(): AsyncIterable<Uint8Array> { yield bytes; }
  for await (const chunk of chunker(source())) {
    leaves.push({ offset, length: chunk.length, digest: sha256Bytes(chunk) });
    offset += chunk.length;
  }
  if (offset !== bytes.length) throw new Error('chunker did not cover input');
  const mapCid = CID.createV1(RAW_CODE, Digest.create(BLAKE3, (await createBLAKE3()).update(bytes).digest('binary')));
  const unixfs = opts.unixfs ? await importUnixfs(bytes) : undefined;
  const bands = opts.bands ? opts.bands(leaves) : [leaves];
  const tree = buildProofTree(bands);
  const descriptor = encodeDescriptor({
    mapCidBytes: mapCid.bytes,
    ...(unixfs === undefined ? {} : { unixfsCidBytes: unixfs.root.bytes }),
    topMeta: tree.topMeta,
    mapSize: bytes.length,
  });
  if (descriptor.length > DESCRIPTOR_CAP) {
    throw new Error(`descriptor exceeds the ${DESCRIPTOR_CAP}-byte cap — split the proof tree deeper`);
  }
  const anchor = CID.createV1(DAG_CBOR_CODE, Digest.create(SHA2_256, sha256Bytes(descriptor))).toString();
  // `root` comes last: a reader that finds it can trust every file it names
  // was written first.
  const proofs = new Map<string, Uint8Array>(tree.files.map((file) => [file.path, file.content]));
  proofs.set('root', descriptor);
  return {
    anchor,
    mapCid: mapCid.toString(),
    ...(unixfs === undefined ? {} : { unixfsCid: unixfs.root.toString(), fullCar: await writeCar(unixfs.root, unixfs.blocks) }),
    descriptor,
    proofs,
    leafCount: leaves.length,
    ...(opts.cuts ? { cuts: opts.cuts } : {}),
  };
}

export class RecordingBlockstore extends MemoryBlockstore {
  recorded = new Map<string, { cid: CID; bytes: Uint8Array }>();

  override async put(cid: CID, bytes: Uint8Array): Promise<CID> {
    this.recorded.set(cid.toString(), { cid, bytes });
    return super.put(cid, bytes) as Promise<CID>;
  }
}

// This intentionally does not use ranges-proof cuts. It reproduces a normal
// Kubo file import, so a mirror can regenerate this CID from the file alone.
async function importUnixfs(bytes: Uint8Array): Promise<{ root: CID; blocks: { cid: CID; bytes: Uint8Array }[] }> {
  const blockstore = new RecordingBlockstore();
  let root: CID | undefined;
  for await (const entry of importer([{ content: bytes }], blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: 262144 }),
  })) root = entry.cid;
  if (root === undefined) throw new Error('UnixFS importer produced no root');
  return { root, blocks: postOrder(root, blockstore.recorded) };
}

// Canonical full-CAR order (SPEC §8): DAG post-order — children left to
// right, then the parent — each block once, at its first occurrence. Unlike
// the importer's put order it is reproducible by a one-pass streaming writer.
export function postOrder<B extends { cid: CID; bytes: Uint8Array }>(root: CID, blocks: Map<string, B>): B[] {
  const ordered: B[] = [];
  const seen = new Set<string>();
  const visit = (cid: CID): void => {
    const key = cid.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const block = blocks.get(key);
    if (block === undefined) throw new Error(`UnixFS block ${key} is missing`);
    if (cid.code === DAG_PB_CODE) for (const link of dagPb.decode(block.bytes).Links) visit(link.Hash);
    ordered.push(block);
  };
  visit(root);
  return ordered;
}

async function writeCar(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await drain;
  const car = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { car.set(chunk, offset); offset += chunk.length; }
  return car;
}

// ---------------------------------------------------------------------------
// Proof tree builder (PLAN-shards §1.2/§1.3): bands → shards → metas
// ---------------------------------------------------------------------------

interface ShardFile {
  start: number;
  length: number;
  content: Uint8Array;
}

// Bands are consecutive leaf runs (zoom bands, or one band for the fixed
// profile), placed in the top meta in order while its running total fits the
// limit with one slot kept for each later band. A small band lists its
// shards there directly. A larger one splits into subdirectories of at most
// subMetaMaxEntries shards, each listed there, so every shard is one small
// meta away from the descriptor. When those do not fit either, the band
// becomes one subdirectory with its own meta tree. Either way the top meta —
// and thereby the descriptor — stays small.
export function buildProofTree(
  bands: RawLeaf[][],
  {
    metaMaxEntries = META_MAX_ENTRIES,
    topMaxEntries = TOP_META_MAX_ENTRIES,
    subMetaMaxEntries = SUB_META_MAX_ENTRIES,
  }: { metaMaxEntries?: number; topMaxEntries?: number; subMetaMaxEntries?: number } = {},
): { files: ProofFile[]; topMeta: Uint8Array } {
  const files: ProofFile[] = [];
  const entries: { kind: number; length: number; digest: Uint8Array }[] = [];
  const subMax = Math.min(subMetaMaxEntries, metaMaxEntries);
  let laterBands = bands.filter((band) => band.length > 0).length;
  for (const band of bands) {
    if (band.length === 0) continue;
    laterBands--;
    const shards = shardGroups(band);
    if (shards.length <= metaMaxEntries && entries.length + shards.length + laterBands <= topMaxEntries) {
      for (const shard of shards) {
        files.push({ path: shardName(shard.start), content: shard.content });
        entries.push({ kind: KIND_SHARD, length: shard.length, digest: sha256Bytes(shard.content) });
      }
      continue;
    }
    const dirs = Math.ceil(shards.length / subMax);
    const split = entries.length + dirs + laterBands <= topMaxEntries;
    for (const dir of splitEvenly(shards, split ? dirs : 1)) {
      const name = shardName(dir[0]!.start);
      const meta = emitDir(dir, `${name}/`, files, metaMaxEntries);
      files.push({ path: `${name}/meta`, content: meta });
      entries.push({
        kind: KIND_DIR,
        length: dir.reduce((n, s) => n + s.length, 0),
        digest: sha256Bytes(meta),
      });
    }
  }
  if (entries.length > topMaxEntries) {
    throw new Error(`top meta needs ${entries.length} entries, over the ${topMaxEntries} limit`);
  }
  return { files, topMeta: encodeMeta(entries) };
}

// `items` cut into `count` consecutive runs whose sizes differ by at most
// one: with q = floor(n / count) and r = n mod count, the first r runs hold
// q + 1 items and the others q.
function splitEvenly<T>(items: T[], count: number): T[][] {
  const size = Math.floor(items.length / count);
  const extra = items.length % count;
  const runs: T[][] = [];
  for (let i = 0, start = 0; i < count; i++) {
    const end = start + size + (i < extra ? 1 : 0);
    runs.push(items.slice(start, end));
    start = end;
  }
  return runs;
}

function shardGroups(leaves: RawLeaf[]): ShardFile[] {
  return shardRanges(leaves).map(([first, end]) => {
    const group = leaves.slice(first, end);
    const start = group[0]!.offset;
    return { start, length: group.reduce((n, l) => n + l.length, 0), content: encodeShard(group, start) };
  });
}

// Each shard's [first, end) leaf indices. A shard closes at the record cap,
// or early when the next leaf's offset relative to the shard start would not
// fit u32.
function shardRanges(leaves: { offset: number }[]): [number, number][] {
  const ranges: [number, number][] = [];
  let first = 0;
  for (let i = 1; i <= leaves.length; i++) {
    if (i < leaves.length && fitsShard(leaves, first, i)) continue;
    ranges.push([first, i]);
    first = i;
  }
  return ranges;
}

function fitsShard(leaves: { offset: number }[], first: number, i: number): boolean {
  return i - first < MAX_SHARD_RECORDS && leaves[i]!.offset - leaves[first]!.offset <= MAX_REL_OFFSET;
}

// Left-shallow nesting (v0.2.0 shape): earliest shards stay at the top, the
// tail nests into subdirectories. The client never depends on the shape.
function emitDir(shards: ShardFile[], prefix: string, files: ProofFile[], maxEntries: number): Uint8Array {
  let head = shards;
  const dirEntries: { kind: number; length: number; digest: Uint8Array }[] = [];
  if (shards.length > maxEntries) {
    const headCount = Math.floor(maxEntries / 2);
    head = shards.slice(0, headCount);
    const rest = shards.slice(headCount);
    const groupSize = Math.ceil(rest.length / (maxEntries - headCount));
    for (let i = 0; i < rest.length; i += groupSize) {
      const group = rest.slice(i, i + groupSize);
      const dirName = shardName(group[0]!.start);
      const meta = emitDir(group, `${prefix}${dirName}/`, files, maxEntries);
      files.push({ path: `${prefix}${dirName}/meta`, content: meta });
      dirEntries.push({
        kind: KIND_DIR,
        length: group.reduce((n, s) => n + s.length, 0),
        digest: sha256Bytes(meta),
      });
    }
  }
  for (const shard of head) {
    files.push({ path: `${prefix}${shardName(shard.start)}`, content: shard.content });
  }
  return encodeMeta([
    ...head.map((s) => ({ kind: KIND_SHARD, length: s.length, digest: sha256Bytes(s.content) })),
    ...dirEntries,
  ]);
}

// Zoom bands for the PMTiles profile: head leaves (before tile data) form
// band zero; tile leaves form maximal consecutive same-zoom runs; sections
// after the tile data (the planet's metadata and leaf directories) form a
// last band. The top meta reads [head shards, z-lo subtree, …, z-max subtree,
// tail]. A leaf is matched to the group COVERING its start — the 16 KiB
// probe cut can split a group, leaving a leaf that starts mid-group.
function pmtilesBands<T extends { offset: number }>(
  leaves: T[],
  { tileDataOffset, tileDataLength }: Header,
  groups: { offset: number; length: number; tileId: number }[],
): T[][] {
  const bands: T[][] = [];
  let band: T[] = [];
  let bandZoom = -1;
  let gi = 0;
  for (const leaf of leaves) {
    let zoom = -1;
    if (leaf.offset >= tileDataOffset && leaf.offset < tileDataOffset + (tileDataLength ?? 0)) {
      while (gi < groups.length && groups[gi]!.offset + groups[gi]!.length <= leaf.offset) gi++;
      const group = groups[gi];
      if (group === undefined || leaf.offset < group.offset) {
        throw new Error(`tile leaf at ${leaf.offset} matches no tile group`);
      }
      zoom = zoomOfTileId(group.tileId);
    }
    if (zoom !== bandZoom && band.length > 0) {
      bands.push(band);
      band = [];
    }
    bandZoom = zoom;
    band.push(leaf);
  }
  if (band.length > 0) bands.push(band);
  return bands;
}

// tileId is the Hilbert index: zoom z covers [ (4^z − 1)/3 , (4^(z+1) − 1)/3 ).
function zoomOfTileId(tileId: number): number {
  let z = 0;
  while (tileId >= (4 ** (z + 1) - 1) / 3) z++;
  return z;
}

// ---------------------------------------------------------------------------
// PMTiles v3 parsing (unchanged semantics; tileIds kept for zoom shaping)
// ---------------------------------------------------------------------------

/**
 * Parse a PMTiles v3 archive and return the ranges which the pmtiles reader
 * can request independently. Directory decoding is delegated to the PMTiles
 * package, including its internal compression handling.
 */
export async function parsePmtiles(bytes: Uint8Array): Promise<ParsedPmtiles> {
  if (!isPmtilesV3(bytes)) throw new Error('not a PMTiles v3 archive');
  if (bytes.length < PMTILES_HEADER_SIZE) throw new Error('truncated PMTiles header');

  const header = bytesToHeader(bytes.slice(0, PMTILES_HEADER_SIZE).buffer);
  if (header.specVersion !== 3) throw new Error(`unsupported PMTiles version ${header.specVersion}`);
  const rootEnd = checkedAdd(header.rootDirectoryOffset, header.rootDirectoryLength, 'root directory end');
  if (rootEnd > PMTILES_PROBE) throw new Error('PMTiles root directory is not contained in the first 16 KiB');
  const boundaries = new Set<number>();
  addSection(boundaries, 0, PMTILES_HEADER_SIZE, bytes.length, 'header');
  addSection(boundaries, header.rootDirectoryOffset, header.rootDirectoryLength, bytes.length, 'root directory');
  addSection(boundaries, header.jsonMetadataOffset, header.jsonMetadataLength, bytes.length, 'metadata');
  addSection(boundaries, header.leafDirectoryOffset, header.leafDirectoryLength ?? 0, bytes.length, 'leaf directories');
  addSection(boundaries, header.tileDataOffset, header.tileDataLength ?? 0, bytes.length, 'tile data');

  const source = memorySource(bytes);
  const cache = new SharedPromiseCache(100, true, decompressPmtiles);
  const rootDirectory = await cache.getDirectory(source, header.rootDirectoryOffset, header.rootDirectoryLength, header);
  const leafDirectories: ParsedPmtiles['leafDirectories'] = [];
  const leafKeys = new Set<string>();
  const tileEntries: Entry[] = [];

  for (const entry of rootDirectory) {
    if (entry.runLength === 0) {
      const offset = checkedAdd(header.leafDirectoryOffset, entry.offset, 'leaf directory offset');
      const key = `${offset}:${entry.length}`;
      if (!leafKeys.has(key)) {
        leafKeys.add(key);
        addSection(boundaries, offset, entry.length, bytes.length, 'leaf directory');
        const entries = await cache.getDirectory(source, offset, entry.length, header);
        leafDirectories.push({ offset, length: entry.length, entries });
        for (const leafEntry of entries) tileEntries.push(leafEntry);
        checkTileEntryCount(tileEntries.length);
      }
      continue;
    }
    tileEntries.push(entry);
    checkTileEntryCount(tileEntries.length);
  }

  const tileRanges: ParsedPmtiles['tileRanges'] = [];
  const tileDataEnd = checkedAdd(header.tileDataOffset, header.tileDataLength ?? 0, 'tile data end');
  for (const entry of tileEntries) {
    if (entry.runLength <= 0) throw new Error('invalid PMTiles tile run length');
    if (!Number.isSafeInteger(entry.tileId)) throw new Error('PMTiles tile id is not a safe integer');
    if (entry.length > 0xffffffff) throw new Error('PMTiles tile length exceeds 0xffffffff');
    const offset = checkedAdd(header.tileDataOffset, entry.offset, 'tile offset');
    const end = checkedAdd(offset, entry.length, 'tile end');
    if (end > tileDataEnd) throw new Error('PMTiles tile lies outside tile data');
    tileRanges.push({ offset, length: entry.length, tileId: entry.tileId });
  }

  const uniqueTiles = uniqueRanges(tileRanges);
  const metadataEnd = checkedAdd(header.jsonMetadataOffset, header.jsonMetadataLength, 'metadata end');
  const metadata = new Uint8Array(await cache.decompress(bytes.slice(header.jsonMetadataOffset, metadataEnd).buffer, header.internalCompression));
  const metadataValue = parseJson(new TextDecoder().decode(metadata));
  if (metadataValue === null || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
    throw new Error('PMTiles metadata must be a JSON object');
  }
  return {
    header,
    metadata,
    rootDirectory,
    leafDirectories,
    tileRanges: uniqueTiles,
    sectionBoundaries: [...boundaries].sort((a, b) => a - b),
  };
}

/** Return absolute PMTiles profile cut points, including both 0 and EOF. */
export async function derivePmtilesCutPoints(bytes: Uint8Array, opts: PmtilesOptions = {}): Promise<number[]> {
  const parsed = await parsePmtiles(bytes);
  const groups = groupedTileRanges(parsed.tileRanges, tileGroupBudget(parsed, bytes.length, opts));
  return pmtilesCutPoints(bytes.length, parsed, groups);
}

function pmtilesCutPoints(
  fileLength: number,
  parsed: ParsedPmtiles,
  groups: { offset: number; length: number }[],
): number[] {
  const boundaries = new Set(parsed.sectionBoundaries);
  if (fileLength > PMTILES_PROBE) boundaries.add(PMTILES_PROBE);
  for (const range of groups) {
    boundaries.add(range.offset);
    boundaries.add(range.offset + range.length);
  }
  boundaries.add(0);
  boundaries.add(fileLength);
  return [...boundaries].sort((a, b) => a - b);
}

function cutLengths(points: number[]): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const length = points[i]! - points[i - 1]!;
    if (length > 0) cuts.push(length);
  }
  return cuts;
}

/** Return PMTiles profile partition lengths suitable for the proof chunker. */
export async function derivePmtilesCuts(bytes: Uint8Array, opts: PmtilesOptions = {}): Promise<number[]> {
  return cutLengths(await derivePmtilesCutPoints(bytes, opts));
}

export function isPmtilesV3(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PMTILES_MAGIC.every((value, i) => bytes[i] === value) && bytes[7] === 3;
}

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => 'memory://pmtiles',
    getBytes: async (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw new Error('invalid PMTiles range');
      }
      return { data: bytes.slice(offset, Math.min(bytes.length, offset + length)).buffer };
    },
  };
}

// Node's own decoders, so their stream quirks (gzip padding, brotli trailing
// bytes) define the format; library error texts are not part of it.
async function decompressPmtiles(bytes: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return bytes;
  const decoders: Partial<Record<Compression, [string, (data: Uint8Array, opts: { maxOutputLength: number }) => Uint8Array]>> = {
    [Compression.Gzip]: ['gzip', gunzipSync],
    [Compression.Brotli]: ['brotli', brotliDecompressSync],
    [Compression.Zstd]: ['zstd', decompressOneZstdFrame],
  };
  const decoder = decoders[compression];
  if (decoder === undefined) throw new Error(`unsupported PMTiles compression ${compression}`);
  const [name, decode] = decoder;
  try {
    return Uint8Array.from(decode(new Uint8Array(bytes), { maxOutputLength: PMTILES_BLOCK_CAP })).buffer;
  } catch {
    throw new Error(`PMTiles ${name} decompression failed`);
  }
}

// Node 22 and 24 disagree on truncated zstd frames and on bytes after a
// frame, so neither defines the format: a block is one complete frame.
function decompressOneZstdFrame(bytes: Uint8Array, options: { maxOutputLength: number }): Uint8Array {
  if (!isOneZstdFrame(bytes)) throw new Error('not one zstd frame');
  return zstdDecompressSync(bytes, options);
}

// Whether `bytes` is one zstd frame (RFC 8878 §3.1.1) and nothing else: the
// header, blocks up to the last one, the checksum when flagged. A skippable
// frame is not one. Decoding checks the rest.
function isOneZstdFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 5 || new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) !== ZSTD_MAGIC) return false;
  const descriptor = bytes[4]!;
  const singleSegment = (descriptor >> 5) & 1;
  let at = 5 + (1 - singleSegment) + [0, 1, 2, 4][descriptor & 3]! + [singleSegment, 2, 4, 8][descriptor >> 6]!;
  for (;;) {
    if (at + 3 > bytes.length) return false;
    const header = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    const type = (header >> 1) & 3;
    if (type === 3) return false;
    at += 3 + (type === 1 ? 1 : header >> 3); // an RLE block is one byte, repeated
    if (header & 1) return at + ((descriptor >> 2) & 1) * 4 === bytes.length;
  }
}

function checkTileEntryCount(count: number): void {
  if (count > PMTILES_MAX_TILE_ENTRIES) throw new Error('PMTiles has more than 2^30 tile entries');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('PMTiles metadata is not valid JSON');
  }
}

function addSection(boundaries: Set<number>, offset: number, length: number, fileLength: number, name: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > fileLength || length > fileLength - offset) {
    throw new Error(`PMTiles ${name} lies outside archive`);
  }
  boundaries.add(offset);
  boundaries.add(offset + length);
}

function checkedAdd(a: number, b: number, name: string): number {
  const result = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(result) || a < 0 || b < 0) {
    throw new Error(`bad PMTiles arithmetic for ${name}`);
  }
  return result;
}

function uniqueRanges<T extends { offset: number; length: number }>(ranges: T[]): T[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.offset}:${range.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupedTileRanges<T extends { offset: number; length: number }>(ranges: T[], budget: number): T[] {
  const groups: T[] = [];
  let group: T | undefined;
  for (const tile of [...ranges].sort((a, b) => a.offset - b.offset)) {
    if (group === undefined || tile.offset !== group.offset + group.length || budget === 0 || group.length + tile.length > budget) {
      if (group !== undefined) groups.push(group);
      group = { ...tile };
      continue;
    }
    group.length += tile.length;
  }
  if (group !== undefined) groups.push(group);
  return groups;
}

function cutChunker(cuts: number[]) {
  return async function* (source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    let buffer = new Uint8Array(0);
    let cut = 0;
    for await (const chunk of source) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
      while (cut < cuts.length && buffer.length >= cuts[cut]!) {
        const length = cuts[cut]!;
        if (length <= 0) throw new Error('PMTiles cuts must be positive');
        yield buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        cut++;
      }
    }
    if (cut < cuts.length || buffer.length > 0) {
      if (cut < cuts.length && buffer.length < cuts[cut]!) throw new Error('PMTiles cuts do not cover input');
      if (buffer.length > 0) yield buffer;
    }
  };
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

// ---------------------------------------------------------------------------
// Fragmented MP4 (the `mp4` profile): a walk over the top-level ISO BMFF boxes
// ---------------------------------------------------------------------------

// Boxes that open a media segment ahead of its `moof`; they travel with it.
const MP4_SEGMENT_BOXES = new Set(['styp', 'emsg', 'prft']);

interface Mp4Box {
  offset: number;
  size: number;
  type: string;
}

/**
 * Whether `--profile auto` packs these bytes as fragmented MP4: an `ftyp`
 * box first, then a top-level `moof` before the walk ends. A malformed box
 * before that only means "not fragmented MP4"; after it, packing fails.
 */
export function isFragmentedMp4(bytes: Uint8Array): boolean {
  try {
    for (const box of mp4Boxes(bytes)) {
      if (box.offset === 0 && box.type !== 'ftyp') return false;
      if (box.type === 'moof') return true;
    }
  } catch {
    // A malformed box before the first `moof`: not fragmented MP4.
  }
  return false;
}

/**
 * The `mp4` profile's leaf lengths: the init section (all before the first
 * fragment), each fragment — its `moof` and `mdat`s, with any `styp`, `emsg`
 * or `prft` boxes before the `moof` — and the boxes after the last `mdat`
 * (an `mfra`). A player that reads a fragment at the range its `sidx` lists
 * reads exactly one leaf.
 */
export function mp4Cuts(bytes: Uint8Array): number[] {
  const points = [0];
  let fragmented = false;
  let segmentStart: number | undefined; // where the run of segment boxes before this box began
  let previous = '';
  for (const box of mp4Boxes(bytes)) {
    if (!fragmented && box.type === 'moof') {
      fragmented = true;
      points.push(segmentStart ?? box.offset);
    } else if (fragmented && previous === 'mdat' && box.type !== 'mdat') {
      points.push(box.offset);
    }
    segmentStart = MP4_SEGMENT_BOXES.has(box.type) ? (segmentStart ?? box.offset) : undefined;
    previous = box.type;
  }
  if (!fragmented) throw new Error('not a fragmented MP4: no moof box');
  return cutLengths([...points, bytes.length]);
}

// Top-level boxes in file order; a malformed box throws.
function* mp4Boxes(bytes: Uint8Array): Generator<Mp4Box> {
  for (let offset = 0; offset < bytes.length;) {
    const box = mp4Box(bytes, offset);
    yield box;
    offset += box.size;
  }
}

// The box at `offset` (ISO/IEC 14496-12 §4.2): a 32-bit size; or 1 and a
// 64-bit size after the type; or 0 for a box that runs to the end of the
// file. Number() rounds only 64-bit sizes of 2^53 and up, which are past the
// end of any file either way.
function mp4Box(bytes: Uint8Array, offset: number): Mp4Box {
  const remaining = bytes.length - offset;
  const fail = (problem: string) => new Error(`MP4 box at ${offset} ${problem}`);
  if (remaining < 8) throw fail('has a truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, remaining);
  const size32 = view.getUint32(0);
  const large = size32 === 1;
  if (large && remaining < 16) throw fail('has a truncated header');
  const size = large ? Number(view.getBigUint64(8)) : size32 === 0 ? remaining : size32;
  if (size < (large ? 16 : 8)) throw fail('has an invalid size');
  if (size > remaining) throw fail('extends past the end of the file');
  return { offset, size, type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) };
}

// ---------------------------------------------------------------------------
// Round-trip verification
// ---------------------------------------------------------------------------

// "1MiB" / "256KiB" / "262144" → bytes.
export function parseChunk(text: string, flag = '--chunk'): number {
  const m = /^(\d+)(KiB|MiB|K|M)?$/.exec(text.trim());
  if (!m) throw new Error(`bad ${flag} value: ${text}`);
  const unit = m[2] === 'KiB' || m[2] === 'K' ? 1024 : m[2] === 'MiB' || m[2] === 'M' ? 1 << 20 : 1;
  const bytes = Number(m[1]) * unit;
  if (!Number.isSafeInteger(bytes)) throw new Error(`bad ${flag} value: ${text}`);
  return bytes;
}

export type ProofReader = (path: string) => Promise<Uint8Array | undefined>;

// Open a real VerifiedFile over in-memory content + proofs and spot-read
// random ranges — the publisher's (and any mirror's) round-trip check.
// Returns the number of reads that verified; throws on any failure.
export async function verifyBytes(
  cid: string,
  content: Uint8Array,
  proofs: Map<string, Uint8Array> | ProofReader,
  opts: { reads?: number; seed?: number } = {},
): Promise<number> {
  const reads = opts.reads ?? 32;
  const readProof = proofs instanceof Map ? async (path: string) => proofs.get(path) : proofs;
  const proofBase = 'mem://file.proofs/';
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
    if (url.startsWith(proofBase)) {
      const body = await readProof(url.slice(proofBase.length));
      return body === undefined
        ? new Response('nf', { status: 404 })
        : new Response(new Uint8Array(body), { status: 200 });
    }
    const range = headers?.Range;
    if (url === 'mem://file' && range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, content.length);
      return new Response(new Uint8Array(content.subarray(start, end)), { status: 206 });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;

  const vf = new VerifiedFile({ cid, source: 'mem://file', fetchFn });
  await vf.ready();
  const size = vf.size ?? content.length;
  if (size !== content.length) throw new Error(`file is ${content.length} bytes, descriptor says ${size}`);
  let x = (opts.seed ?? 1) >>> 0 || 1;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
  let checked = 0;
  for (let i = 0; i < reads; i++) {
    const offset = Math.floor(rand() * Math.max(1, size));
    const length = 1 + Math.floor(rand() * Math.min(size - offset, 1 << 16));
    const got = await vf.read(offset, length);
    const want = content.subarray(offset, offset + got.length);
    if (got.length !== want.length || !got.every((b, j) => b === want[j])) {
      throw new Error(`read(${offset}, ${length}) did not match the source`);
    }
    checked++;
  }
  return checked;
}

export interface PackedAssets {
  anchor: string;
  manifest: Uint8Array;
  car: Uint8Array;
  files: Map<string, Uint8Array>;
}

// Inline policy for `pack assets`: a directory whose files total at most this
// many bytes is carried whole in the bundle CAR, so one fetch serves the
// bundle. Anything larger emits the manifest alone — the proof — and the
// client fetches content from `{base}/{path}` (SPEC §3.2 fallback).
const INLINE_TOTAL_CAP = 256 * 1024;

/** Build a MASL bundle CAR from a directory. Directories over INLINE_TOTAL_CAP emit a manifest-only proof; content stays URL-fetched. */
export async function packAssets(directory: string, { types = new Map<string, string>() }: { types?: Map<string, string> } = {}): Promise<PackedAssets> {
  const files = new Map<string, Uint8Array>();
  // Identical files share one CAR section: a bag with a repeated CID is
  // rejected by the client (SPEC §3.3).
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const entries: [string, { src: CID; size: number; contentType?: string }][] = [];
  const walk = async (relative: string): Promise<void> => {
    const listing = await readdir(join(directory, relative), { withFileTypes: true, encoding: 'buffer' });
    const items = listing.map((item) => ({ item, name: utf8Name(item.name, relative) }));
    items.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const { item, name } of items) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (item.isDirectory()) { await walk(path); continue; }
      if (!item.isFile()) continue;
      const bytes = new Uint8Array(await readFile(join(directory, path)));
      const cid = CID.createV1(RAW_CODE, Digest.create(SHA2_256, sha256Bytes(bytes)));
      if (!blocks.has(cid.toString())) blocks.set(cid.toString(), { cid, bytes });
      const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      const contentType = types.get(extension) ?? DEFAULT_ASSET_TYPES.get(extension);
      files.set(path, bytes);
      entries.push([`/${path}`, { src: cid, size: bytes.length, ...(contentType === undefined ? {} : { contentType }) }]);
    }
  };
  await walk('');
  const manifest = encodeManifest(entries.map(([path, entry]) => [path, {
    src: { codec: entry.src.code, hashCode: entry.src.multihash.code, digest: entry.src.multihash.digest, bytes: entry.src.bytes },
    size: entry.size,
    ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
  }] as const), { withType: true });
  const root = CID.createV1(DAG_CBOR_CODE, Digest.create(SHA2_256, sha256Bytes(manifest)));
  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  await writer.put({ cid: root, bytes: manifest });
  const total = [...blocks.values()].reduce((n, block) => n + block.bytes.length, 0);
  if (total <= INLINE_TOTAL_CAP) {
    for (const block of blocks.values()) await writer.put(block);
  } else {
    process.stderr.write(`assets: ${total} B exceeds the ${INLINE_TOTAL_CAP} B inline budget; the CAR carries the manifest only and content is fetched from the content URL\n`);
  }
  await writer.close(); await drain;
  return { anchor: root.toString(), manifest, car: concatChunks(chunks), files };
}

// Manifest paths are text; a name that is not UTF-8 has no faithful path.
function utf8Name(name: Uint8Array, relative: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(name);
  } catch {
    const lossy = new TextDecoder('utf-8', { ignoreBOM: true }).decode(name);
    throw new Error(`asset name is not valid UTF-8: ${relative === '' ? lossy : `${relative}/${lossy}`}`);
  }
}

const DEFAULT_ASSET_TYPES = new Map<string, string>([
  ['json', 'application/json'], ['pbf', 'application/x-protobuf'], ['png', 'image/png'],
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
]);

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const car = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let pos = 0;
  for (const chunk of chunks) { car.set(chunk, pos); pos += chunk.length; }
  return car;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const PACK_USAGE = 'usage: pack <input> [--profile auto|fixed|pmtiles|mp4] [--chunk N] [--tile-group N] [--unixfs] [--full-car pin.car] [--out dir]';
const ASSETS_USAGE = 'usage: pack assets <dir> [--out bundle.car] [--type ext=mime]';
const VERIFY_USAGE = 'usage: pack verify --cid <anchor> --file <path> --proofs <dir>';
// Enough random reads to cross many shards; not a knob, since a full check
// belongs to the Rust packer's verify.
const VERIFY_READS = 64;

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'verify') return verifyCommand(argv.slice(1));
  if (argv[0] === 'assets') return assetsCommand(argv.slice(1));
  return packCommand(argv);
}

async function verifyCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, { values: ['cid', 'file', 'proofs'], positionals: 0 });
  if (opts.cid === undefined || opts.file === undefined || opts.proofs === undefined) throw new Error(VERIFY_USAGE);
  const content = await readInput(opts.file);
  await verifyBytes(opts.cid, content, proofReader(opts.proofs), { reads: VERIFY_READS });
  process.stdout.write('verify OK\n');
}

async function assetsCommand(args: string[]): Promise<void> {
  const { positionals: [directory], opts } = parseArgs(args, { values: ['out', 'type'], positionals: 1 });
  if (directory === undefined) throw new Error(ASSETS_USAGE);
  const types = new Map<string, string>();
  for (const value of opts.type?.split(',') ?? []) {
    const equals = value.indexOf('=');
    if (equals <= 0 || equals === value.length - 1) throw new Error(`bad --type ${value}`);
    types.set(value.slice(0, equals).replace(/^\./, '').toLowerCase(), value.slice(equals + 1));
  }
  const packed = await packAssets(directory, { types });
  const out = opts.out ?? 'bundle.car';
  await writeFile(out, packed.car);
  await writeFile(blockPath(out), packed.manifest);
  process.stdout.write(`${packed.anchor}\n`);
}

// The bare manifest block beside the CAR (`bundle.car` → `bundle.masl`): the
// anchor's own bytes, the URL a router lists for the bundle (SPEC §3.2, §6).
function blockPath(out: string): string {
  return `${out.endsWith('.car') ? out.slice(0, -'.car'.length) : out}.masl`;
}

async function packCommand(args: string[]): Promise<void> {
  const { positionals: [input], opts } = parseArgs(args, {
    values: ['profile', 'chunk', 'tile-group', 'out', 'full-car'],
    booleans: ['unixfs'],
    positionals: 1,
  });
  if (input === undefined) throw new Error(PACK_USAGE);
  const fullCar = opts['full-car'];
  if (fullCar !== undefined && opts.unixfs === undefined) throw new Error('--full-car requires --unixfs');
  const chunkSize = opts.chunk === undefined ? undefined : parseChunk(opts.chunk);
  const tileGroupBytes = opts['tile-group'] === undefined ? undefined : parseChunk(opts['tile-group'], '--tile-group');
  const out = opts.out ?? `${input}.proofs`;
  refuseInput(input, out, '--out');
  if (resolve(input).startsWith(resolve(out) + sep)) throw new Error('--out contains the input file');
  if (fullCar !== undefined) {
    refuseInput(input, fullCar, '--full-car');
    refuseInput(input, `${fullCar}.tmp`, '--full-car');
  }
  const bytes = await readInput(input);
  const packed = await pack(bytes, {
    profile: opts.profile as PackProfile | undefined,
    chunkSize,
    tileGroupBytes,
    unixfs: opts.unixfs !== undefined,
  });
  await writeOutputs(input, out, packed, fullCar);
  process.stdout.write(`${packed.anchor}\n`);
  const tileGroup = packed.tileGroupBytes === undefined ? '' : `tile group: ${packed.tileGroupBytes} bytes\n`;
  process.stderr.write(
    `proofs: ${out}/ (${packed.leafCount} leaves, ${packed.proofs.size} files, descriptor ${packed.descriptor.length} bytes)\n${tileGroup}map: ${packed.mapCid}${packed.unixfsCid === undefined ? '' : `\nunixfs: ${packed.unixfsCid}`}\n`,
  );
}

// Directories first, then outputs that are the input file are refused, then
// the CAR's `.tmp` is opened before any proof file is written (a failure is
// reported after them), as the Rust packer does. Once the `.tmp` exists, any
// failure removes it.
async function writeOutputs(input: string, out: string, packed: Packed, fullCar: string | undefined): Promise<void> {
  const dirs = new Set([...packed.proofs.keys()].map((path) => dirname(`${out}/${path}`)));
  for (const dir of dirs) await mkdir(dir, { recursive: true });
  await refuseInputAliases(input, out, packed, fullCar);
  if (fullCar === undefined) return writeProofs(out, packed);
  const tmp = `${fullCar}.tmp`;
  const car = await open(tmp, 'w').catch((err: Error) => err);
  if (car instanceof Error) {
    await writeProofs(out, packed);
    throw car;
  }
  try {
    await writeProofs(out, packed);
    await car.writeFile(packed.fullCar!);
    await car.close();
    // A crash mid-write must not leave a truncated CAR under the final name.
    await rename(tmp, fullCar);
  } catch (err) {
    await car.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function writeProofs(out: string, packed: Packed): Promise<void> {
  for (const [path, content] of packed.proofs) await writeFile(`${out}/${path}`, content);
}

// Existing outputs that are the input file (a hardlink, or a path through a
// symlink) are refused before any output is opened; the path checks in
// packCommand miss these, and the Rust packer would fault on its input map.
async function refuseInputAliases(input: string, out: string, packed: Packed, fullCar: string | undefined): Promise<void> {
  const id = await fileId(input);
  if (id === undefined) return;
  for (const path of packed.proofs.keys()) {
    if (await fileId(`${out}/${path}`) === id) throw new Error('--out contains the input file');
  }
  if (fullCar !== undefined && await fileId(`${fullCar}.tmp`) === id) throw new Error('--full-car resolves to the input file');
}

// `dev:ino` of the file a path names (symlinks followed); undefined when it cannot be stat'd.
async function fileId(path: string): Promise<string | undefined> {
  const stats = await stat(path, { bigint: true }).catch(() => undefined);
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
}

function refuseInput(input: string, output: string, flag: string): void {
  if (resolve(output) === resolve(input)) throw new Error(`${flag} resolves to the input file`);
}

// Reads a proof file only when the verifier asks for it; a missing one is a 404.
function proofReader(dir: string): ProofReader {
  return async (path) => {
    try {
      return new Uint8Array(await readFile(`${dir}/${path}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  };
}

// Strict flags: anything the command does not use is an error, never ignored.
function parseArgs(
  args: string[],
  spec: { values: string[]; booleans?: string[]; positionals: number },
): { positionals: string[]; opts: Record<string, string> } {
  const positionals: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      if (positionals.length === spec.positionals) throw new Error(`unexpected argument ${arg}`);
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.booleans?.includes(name)) { opts[name] = 'true'; continue; }
    if (!spec.values.includes(name)) throw new Error(`unknown flag ${arg}`);
    const value = args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    opts[name] = value;
  }
  return { positionals, opts };
}

async function readInput(pathOrUrl: string): Promise<Uint8Array> {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const res = await fetch(pathOrUrl);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await readFile(pathOrUrl));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
