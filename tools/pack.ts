// The veritiles packer (devDependencies only — NOT part of the shipped bundle).
// Turns a file into a verified pair: its raw whole-file CID and a dag-cbor
// descriptor plus a meta/shard tree of static files (PLAN-shards §3).
// `verify` opens a real VerifiedFile over the emitted package and spot-reads
// random ranges.
//
//   npm run pack -- map.pmtiles                      → ./map.pmtiles.proofs/
//   npm run pack -- map.pmtiles --tile-group 1MiB
//   npm run pack -- verify --cid b… --file <path> --proofs <dir> [--reads 64]

import { CarWriter } from '@ipld/car';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import * as zlib from 'node:zlib';
import { bytesToHeader, Compression, SharedPromiseCache, type Entry, type Header, type Source } from 'pmtiles';

import { encodeDescriptor } from '../src/descriptor.ts';
import { encodeManifest } from '../src/manifest.ts';
import { DESCRIPTOR_CAP } from '../src/limits.ts';
import {
  encodeMeta,
  encodeShard,
  KIND_DIR,
  KIND_SHARD,
  MAX_SHARD_RECORDS,
  META_RECORD_SIZE,
  shardName,
} from '../src/proof-format.ts';
import { VerifiedFile } from '../src/verified-file.ts';

const RAW_CODE = 0x55;
const SHA2_256 = 0x12;
const DAG_CBOR_CODE = 0x71;
const META_FILE_CAP = 256 * 1024;
const META_MAX_ENTRIES = Math.floor(META_FILE_CAP / META_RECORD_SIZE);
const DEFAULT_CHUNK = 1 << 20; // 1 MiB — the `fixed` profile default
const DEFAULT_TILE_GROUP = 1 << 20; // 1 MiB — the `pmtiles` profile default
const PMTILES_HEADER_SIZE = 127;
const PMTILES_PROBE = 16384;
const PMTILES_MAGIC = Uint8Array.from([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]);

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
  /** The content's raw whole-file CID. */
  mapCid: string;
  descriptor: Uint8Array;
  /** Proof-base-relative files: 'root', '{hex}', '{hex}/meta', … */
  proofs: Map<string, Uint8Array>;
  leafCount: number;
  /** The byte lengths emitted by a content-aware profile, when applicable. */
  cuts?: number[];
}

export interface PmtilesOptions {
  /** Maximum bytes in one tile-data leaf. Defaults to 1 MiB. Use 0 for one tile per leaf. */
  tileGroupBytes?: number;
  /** Alias for the CLI's `--tile-group` option. */
  tileGroup?: number;
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
export async function packFixed(bytes: Uint8Array, opts: { chunkSize?: number } = {}): Promise<Packed> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  return packWithChunker(bytes, fixedSize({ chunkSize }), {});
}

/** Pack a PMTiles v3 archive using the profile from PLAN-shards §3 (zoom-shaped). */
export async function packPmtiles(bytes: Uint8Array, opts: PmtilesOptions = {}): Promise<Packed> {
  const parsed = await parsePmtiles(bytes);
  const tileGroupBytes = opts.tileGroupBytes ?? opts.tileGroup ?? DEFAULT_TILE_GROUP;
  if (!Number.isSafeInteger(tileGroupBytes) || tileGroupBytes < 0) {
    throw new Error(`bad tile grouping budget: ${tileGroupBytes}`);
  }
  const groups = groupedTileRanges(parsed.tileRanges, tileGroupBytes);
  const cuts = cutLengths(pmtilesCutPoints(bytes, parsed, groups));
  return packWithChunker(bytes, cutChunker(cuts), {
    cuts,
    bands: (leaves) => pmtilesBands(leaves, parsed.header.tileDataOffset, groups),
  });
}

export type PackProfile = 'auto' | 'fixed' | 'pmtiles';

export interface PackOptions extends PmtilesOptions {
  profile?: PackProfile;
  chunkSize?: number;
}

/** Select the PMTiles profile by magic/version, unless the caller overrides it. */
export async function pack(bytes: Uint8Array, opts: PackOptions = {}): Promise<Packed> {
  if (opts.profile === 'fixed' || !isPmtilesV3(bytes)) {
    return packFixed(bytes, { chunkSize: opts.chunkSize });
  }
  return packPmtiles(bytes, opts);
}

async function packWithChunker(
  bytes: Uint8Array,
  chunker: (source: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>,
  opts: { cuts?: number[]; bands?: (leaves: RawLeaf[]) => RawLeaf[][] },
): Promise<Packed> {
  const leaves: RawLeaf[] = [];
  let offset = 0;
  async function* source(): AsyncIterable<Uint8Array> { yield bytes; }
  for await (const chunk of chunker(source())) {
    leaves.push({ offset, length: chunk.length, digest: sha256Bytes(chunk) });
    offset += chunk.length;
  }
  if (offset !== bytes.length) throw new Error('chunker did not cover input');
  const mapCid = CID.createV1(RAW_CODE, Digest.create(SHA2_256, sha256Bytes(bytes)));
  const bands = opts.bands ? opts.bands(leaves) : [leaves];
  const tree = buildProofTree(bands);
  const descriptor = encodeDescriptor({ mapCidBytes: mapCid.bytes, topMeta: tree.topMeta, mapSize: bytes.length });
  if (descriptor.length > DESCRIPTOR_CAP) {
    throw new Error(`descriptor exceeds the ${DESCRIPTOR_CAP}-byte cap — split the proof tree deeper`);
  }
  const anchor = CID.createV1(DAG_CBOR_CODE, Digest.create(SHA2_256, sha256Bytes(descriptor))).toString();
  const proofs = new Map<string, Uint8Array>([['root', descriptor]]);
  for (const file of tree.files) proofs.set(file.path, file.content);
  return {
    anchor,
    mapCid: mapCid.toString(),
    descriptor,
    proofs,
    leafCount: leaves.length,
    ...(opts.cuts ? { cuts: opts.cuts } : {}),
  };
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
// profile). A small band lists its shards directly in the top meta; a band
// with more shards than a meta can hold becomes a subdirectory with its own
// meta tree, so the top meta — and thereby the descriptor — stays small.
export function buildProofTree(
  bands: RawLeaf[][],
  { metaMaxEntries = META_MAX_ENTRIES }: { metaMaxEntries?: number } = {},
): { files: ProofFile[]; topMeta: Uint8Array } {
  const files: ProofFile[] = [];
  const entries: { kind: number; length: number; digest: Uint8Array }[] = [];
  for (const band of bands) {
    if (band.length === 0) continue;
    const shards = shardGroups(band);
    if (shards.length <= metaMaxEntries) {
      for (const shard of shards) {
        files.push({ path: shardName(shard.start), content: shard.content });
        entries.push({ kind: KIND_SHARD, length: shard.length, digest: sha256Bytes(shard.content) });
      }
      continue;
    }
    const name = shardName(shards[0]!.start);
    const meta = emitDir(shards, `${name}/`, files, metaMaxEntries);
    files.push({ path: `${name}/meta`, content: meta });
    entries.push({
      kind: KIND_DIR,
      length: shards.reduce((n, s) => n + s.length, 0),
      digest: sha256Bytes(meta),
    });
  }
  return { files, topMeta: encodeMeta(entries) };
}

function shardGroups(leaves: RawLeaf[]): ShardFile[] {
  const shards: ShardFile[] = [];
  for (let i = 0; i < leaves.length; i += MAX_SHARD_RECORDS) {
    const group = leaves.slice(i, i + MAX_SHARD_RECORDS);
    const start = group[0]!.offset;
    shards.push({
      start,
      length: group.reduce((n, l) => n + l.length, 0),
      content: encodeShard(group, start),
    });
  }
  return shards;
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
// band zero; tile leaves form maximal consecutive same-zoom runs, so the
// top meta reads [head shards, z-lo subtree, …, z-max subtree]. A leaf is
// matched to the group COVERING its start — the 16 KiB probe cut can split
// a group, leaving a leaf that starts mid-group.
function pmtilesBands(
  leaves: RawLeaf[],
  tileDataOffset: number,
  groups: { offset: number; length: number; tileId: number }[],
): RawLeaf[][] {
  const bands: RawLeaf[][] = [];
  let band: RawLeaf[] = [];
  let bandZoom = -1;
  let gi = 0;
  for (const leaf of leaves) {
    let zoom = -1;
    if (leaf.offset >= tileDataOffset) {
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
        tileEntries.push(...entries);
      }
      continue;
    }
    tileEntries.push(entry);
  }

  const tileRanges: ParsedPmtiles['tileRanges'] = [];
  const tileDataEnd = checkedAdd(header.tileDataOffset, header.tileDataLength ?? 0, 'tile data end');
  for (const entry of tileEntries) {
    if (entry.runLength <= 0) throw new Error('invalid PMTiles tile run length');
    const offset = checkedAdd(header.tileDataOffset, entry.offset, 'tile offset');
    const end = checkedAdd(offset, entry.length, 'tile end');
    if (end > tileDataEnd) throw new Error('PMTiles tile lies outside tile data');
    tileRanges.push({ offset, length: entry.length, tileId: entry.tileId });
  }

  const uniqueTiles = uniqueRanges(tileRanges);
  const metadataEnd = checkedAdd(header.jsonMetadataOffset, header.jsonMetadataLength, 'metadata end');
  const metadata = new Uint8Array(await cache.decompress(bytes.slice(header.jsonMetadataOffset, metadataEnd).buffer, header.internalCompression));
  const metadataValue: unknown = JSON.parse(new TextDecoder().decode(metadata));
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
  const tileGroupBytes = opts.tileGroupBytes ?? opts.tileGroup ?? DEFAULT_TILE_GROUP;
  if (!Number.isSafeInteger(tileGroupBytes) || tileGroupBytes < 0) {
    throw new Error(`bad tile grouping budget: ${tileGroupBytes}`);
  }
  return pmtilesCutPoints(bytes, parsed, groupedTileRanges(parsed.tileRanges, tileGroupBytes));
}

function pmtilesCutPoints(
  bytes: Uint8Array,
  parsed: ParsedPmtiles,
  groups: { offset: number; length: number }[],
): number[] {
  const boundaries = new Set(parsed.sectionBoundaries);
  if (bytes.length > PMTILES_PROBE) boundaries.add(PMTILES_PROBE);
  for (const range of groups) {
    boundaries.add(range.offset);
    boundaries.add(range.offset + range.length);
  }
  boundaries.add(0);
  boundaries.add(bytes.length);
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

async function decompressPmtiles(bytes: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return bytes;
  const input = new Uint8Array(bytes);
  const output = compression === Compression.Gzip
    ? gunzipSync(input)
    : compression === Compression.Brotli
      ? brotliDecompressSync(input)
      : compression === Compression.Zstd
        ? (zlib as typeof zlib & { zstdDecompressSync?: (data: Uint8Array) => Uint8Array }).zstdDecompressSync?.(input)
        : undefined;
  if (output === undefined) throw new Error(`unsupported PMTiles compression ${compression}`);
  return Uint8Array.from(output).buffer;
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
// Round-trip verification
// ---------------------------------------------------------------------------

// "1MiB" / "256KiB" / "262144" → bytes.
export function parseChunk(text: string): number {
  const m = /^(\d+)(KiB|MiB|K|M)?$/.exec(text.trim());
  if (!m) throw new Error(`bad --chunk value: ${text}`);
  const n = Number(m[1]);
  const unit = m[2] === 'KiB' || m[2] === 'K' ? 1024 : m[2] === 'MiB' || m[2] === 'M' ? 1 << 20 : 1;
  return n * unit;
}

// Open a real VerifiedFile over in-memory content + proofs and spot-read
// random ranges — the publisher's (and any mirror's) round-trip check.
// Returns the number of reads that verified; throws on any failure.
export async function verifyBytes(
  cid: string,
  content: Uint8Array,
  proofs: Map<string, Uint8Array>,
  opts: { reads?: number; seed?: number } = {},
): Promise<number> {
  const reads = opts.reads ?? 32;
  const proofBase = 'mem://file.proofs/';
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
    if (url.startsWith(proofBase)) {
      const body = proofs.get(url.slice(proofBase.length));
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

/** Build a MASL bundle CAR from a directory. Large files stay URL-fetched. */
export async function packAssets(directory: string, { types = new Map<string, string>() }: { types?: Map<string, string> } = {}): Promise<PackedAssets> {
  const files = new Map<string, Uint8Array>();
  const entries: [string, { src: CID; size: number; contentType?: string }][] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? item.name : `${relative}/${item.name}`;
      if (item.isDirectory()) { await walk(path); continue; }
      if (!item.isFile()) continue;
      const bytes = new Uint8Array(await readFile(join(directory, path)));
      const cid = CID.createV1(RAW_CODE, Digest.create(SHA2_256, sha256Bytes(bytes)));
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
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
  for (const [path, bytes] of files) {
    if (bytes.length > 2 ** 23) { process.stderr.write(`warning: ${path} exceeds CAR raw-section cap; it will be fetched from content URL\n`); continue; }
    await writer.put({ cid: CID.createV1(RAW_CODE, Digest.create(SHA2_256, sha256Bytes(bytes))), bytes });
  }
  await writer.close(); await drain;
  return { anchor: root.toString(), manifest, car: concatChunks(chunks), files };
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

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'verify') {
    const opts = flags(argv.slice(1));
    const content = await readInput(opts.file!);
    const proofs = await readProofDir(opts.proofs!);
    const checked = await verifyBytes(opts.cid!, content, proofs, { reads: opts.reads ? Number(opts.reads) : undefined });
    process.stdout.write(`verify OK: ${checked} reads matched the source\n`);
    return;
  }
  if (argv[0] === 'assets') {
    const directory = argv[1];
    if (!directory) throw new Error('usage: pack assets <dir> [--out bundle.car] [--type ext=mime]');
    const opts = flags(argv.slice(2));
    const types = new Map<string, string>();
    for (const value of opts.type?.split(',') ?? []) {
      const equals = value.indexOf('=');
      if (equals <= 0 || equals === value.length - 1) throw new Error(`bad --type ${value}`);
      types.set(value.slice(0, equals).replace(/^\./, '').toLowerCase(), value.slice(equals + 1));
    }
    const packed = await packAssets(directory, { types });
    await writeFile(opts.out ?? 'bundle.car', packed.car);
    process.stdout.write(`${packed.anchor}\n`);
    return;
  }
  const input = argv[0];
  if (!input) throw new Error('usage: pack <input> [--profile auto|fixed|pmtiles] [--chunk N] [--tile-group N] [--out dir]');
  const opts = flags(argv.slice(1));
  const bytes = await readInput(input);
  const packed = await pack(bytes, {
    profile: opts.profile as PackProfile | undefined,
    chunkSize: opts.chunk ? parseChunk(opts.chunk) : undefined,
    tileGroupBytes: opts['tile-group'] ? parseChunk(opts['tile-group']) : undefined,
  });
  const out = opts.out ?? `${input}.proofs`;
  for (const [path, content] of packed.proofs) {
    const file = `${out}/${path}`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  if (opts['full-car']) throw new Error('--full-car requires --unixfs and is not available in this build');
  process.stdout.write(`${packed.anchor}\n`);
  process.stderr.write(
    `proofs: ${out}/ (${packed.leafCount} leaves, ${packed.proofs.size} files, descriptor ${packed.descriptor.length} bytes)\nmap: ${packed.mapCid}\n`,
  );
}

async function readProofDir(dir: string): Promise<Map<string, Uint8Array>> {
  const { readdir } = await import('node:fs/promises');
  const proofs = new Map<string, Uint8Array>();
  const walk = async (sub: string): Promise<void> => {
    for (const entry of await readdir(`${dir}/${sub}`, { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else proofs.set(rel, await readFile(`${dir}/${rel}`));
    }
  };
  await walk('');
  return proofs;
}

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.slice(2);
      out[key] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true';
    }
  }
  return out;
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
