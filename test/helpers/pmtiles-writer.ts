// Minimal PMTiles v3 writer — just enough archive for the real `pmtiles`
// reader to open: uncompressed tiles, directories and metadata stored raw or
// with any internal compression. It can emit direct root entries or
// root-referenced leaf directories for publisher tests, and `assemblePmtiles`
// lays out arbitrary (adversarial) sections for the differential corpus.

import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

export interface TileSpec {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

export interface PlacedTile {
  z: number;
  x: number;
  y: number;
  /** Absolute byte range of this tile inside the archive. */
  offset: number;
  length: number;
}

export interface WrittenArchive {
  bytes: Uint8Array;
  /** Leaf lengths for buildMapPackage: [prefix, ...tile lengths]. */
  cuts: number[];
  tileDataOffset: number;
  /** Tiles in on-disk (tile-id) order, with absolute byte ranges. */
  tiles: PlacedTile[];
}

export interface WritePmtilesOptions {
  /** Put at most this many tile entries in each root-referenced leaf directory. */
  rootEntriesPerLeaf?: number;
  /** Internal compression code for directories and metadata (default 1, none). */
  compression?: number;
  /** Metadata JSON bytes before compression (default `{}`). */
  metadata?: Uint8Array;
}

export function writePmtilesArchive(tiles: TileSpec[], opts: WritePmtilesOptions = {}): WrittenArchive {
  if (tiles.length === 0) throw new Error('at least one tile is required');
  const entries = tiles
    .map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) }))
    .sort((a, b) => a.id - b.id);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.id === entries[i - 1]!.id) throw new Error('duplicate tile');
  }

  let offset = 0;
  const placed = entries.map((e) => {
    const p = { ...e, offset, length: e.data.length };
    offset += e.data.length;
    return p;
  });
  const leafDirectories: Uint8Array[] = [];
  let rootEntries: { id: number; offset: number; length: number; runLength: number }[];
  if (opts.rootEntriesPerLeaf !== undefined && opts.rootEntriesPerLeaf > 0 && opts.rootEntriesPerLeaf < placed.length) {
    rootEntries = [];
    for (let i = 0; i < placed.length; i += opts.rootEntriesPerLeaf) {
      const leafEntries = placed.slice(i, i + opts.rootEntriesPerLeaf);
      const leaf = compress(encodeDirectory(leafEntries), opts.compression ?? 1);
      rootEntries.push({ id: leafEntries[0]!.id, offset: leafDirectories.reduce((n, b) => n + b.length, 0), length: leaf.length, runLength: 0 });
      leafDirectories.push(leaf);
    }
  } else {
    rootEntries = placed.map((e) => ({ ...e, runLength: 1 }));
  }
  const encodedRoot = compress(encodeDirectory(rootEntries), opts.compression ?? 1);
  const metadataBytes = compress(opts.metadata ?? new TextEncoder().encode('{}'), opts.compression ?? 1);
  const rootDirOffset = 127;
  const metadataOffset = rootDirOffset + encodedRoot.length;
  const leafDirectoryOffset = metadataOffset + metadataBytes.length;
  const leafDirectoryLength = leafDirectories.reduce((n, b) => n + b.length, 0);
  const tileDataOffset = leafDirectoryOffset + leafDirectoryLength;
  const tileDataLength = offset;

  const bytes = new Uint8Array(tileDataOffset + tileDataLength);
  writeHeader(bytes, {
    rootDirOffset, rootDirLength: encodedRoot.length, metadataOffset, metadataLength: metadataBytes.length,
    leafDirectoryOffset, leafDirectoryLength, tileDataOffset, tileDataLength,
    tileCount: placed.length, minZoom: Math.min(...tiles.map((t) => t.z)), maxZoom: Math.max(...tiles.map((t) => t.z)),
    compression: opts.compression,
  });

  bytes.set(encodedRoot, rootDirOffset);
  bytes.set(metadataBytes, metadataOffset);
  let leafOffset = leafDirectoryOffset;
  for (const leaf of leafDirectories) {
    bytes.set(leaf, leafOffset);
    leafOffset += leaf.length;
  }
  for (const p of placed) bytes.set(p.data, tileDataOffset + p.offset);

  return {
    bytes,
    cuts: [tileDataOffset, ...placed.map((p) => p.length)],
    tileDataOffset,
    tiles: placed.map((p) => ({
      z: p.z,
      x: p.x,
      y: p.y,
      offset: tileDataOffset + p.offset,
      length: p.length,
    })),
  };
}

interface HeaderFields {
  rootDirOffset: number; rootDirLength: number; metadataOffset: number; metadataLength: number;
  leafDirectoryOffset: number; leafDirectoryLength: number; tileDataOffset: number; tileDataLength: number;
  tileCount: number; minZoom: number; maxZoom: number; compression?: number;
}

function writeHeader(bytes: Uint8Array, h: HeaderFields): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const u64 = (pos: number, value: number) => dv.setBigUint64(pos, BigInt(value), true);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]); // "PMTiles"
  bytes[7] = 3; // spec version
  u64(8, h.rootDirOffset);
  u64(16, h.rootDirLength);
  u64(24, h.metadataOffset);
  u64(32, h.metadataLength);
  u64(40, h.leafDirectoryOffset);
  u64(48, h.leafDirectoryLength);
  u64(56, h.tileDataOffset);
  u64(64, h.tileDataLength);
  u64(72, h.tileCount); // addressed tiles
  u64(80, h.tileCount); // tile entries
  u64(88, h.tileCount); // tile contents
  bytes[96] = 1; // clustered
  bytes[97] = h.compression ?? 1; // internal_compression
  bytes[98] = 1; // tile_compression: none
  bytes[99] = 1; // tile_type: mvt
  bytes[100] = h.minZoom;
  bytes[101] = h.maxZoom;
  dv.setInt32(102, -180e7, true); // min lon (e7)
  dv.setInt32(106, -85e7, true); // min lat
  dv.setInt32(110, 180e7, true); // max lon
  dv.setInt32(114, 85e7, true); // max lat
  bytes[118] = h.minZoom; // center zoom
  dv.setInt32(119, 0, true); // center lon
  dv.setInt32(123, 0, true); // center lat
}

/**
 * An archive whose root directory holds exactly `entries` (offsets relative
 * to tile data) over `tileDataLength` zero bytes — for adversarial entries
 * the tile-spec writer cannot express.
 */
export function writeRawPmtilesArchive(
  entries: { id: number; offset: number; length: number; runLength: number }[],
  tileDataLength: number,
): Uint8Array {
  const root = encodeDirectory(entries);
  const metadata = new TextEncoder().encode('{}');
  const metadataOffset = 127 + root.length;
  const tileDataOffset = metadataOffset + metadata.length;
  const bytes = new Uint8Array(tileDataOffset + tileDataLength);
  writeHeader(bytes, {
    rootDirOffset: 127, rootDirLength: root.length, metadataOffset, metadataLength: metadata.length,
    leafDirectoryOffset: tileDataOffset, leafDirectoryLength: 0, tileDataOffset, tileDataLength,
    tileCount: entries.length, minZoom: 0, maxZoom: 0,
  });
  bytes.set(root, 127);
  bytes.set(metadata, metadataOffset);
  return bytes;
}

export type Section = 'root' | 'metadata' | 'leaves' | 'tiles' | 'pad';

export interface PmtilesParts {
  /** Stored (already compressed) root directory. */
  root: Uint8Array;
  /** Stored metadata; default `{}`. */
  metadata?: Uint8Array;
  /** Stored leaf directory section. */
  leaves?: Uint8Array;
  tiles?: Uint8Array;
  /** Filler bytes for the `pad` section: gaps, or a root pushed past 16 KiB. */
  pad?: Uint8Array;
  /** Internal compression code written to the header (default 1, none). */
  compression?: number;
  /** Section order after the 127-byte header. */
  order?: Section[];
  /** Header fields to overwrite after layout, e.g. out-of-range lengths. */
  header?: Partial<HeaderFields>;
}

/** Lays out `parts` in `order` behind a header that points at each section. */
export function assemblePmtiles(parts: PmtilesParts): Uint8Array {
  const sections: Record<Section, Uint8Array> = {
    root: parts.root,
    metadata: parts.metadata ?? new TextEncoder().encode('{}'),
    leaves: parts.leaves ?? new Uint8Array(0),
    tiles: parts.tiles ?? new Uint8Array(0),
    pad: parts.pad ?? new Uint8Array(0),
  };
  const order = parts.order ?? ['root', 'metadata', 'leaves', 'tiles'];
  const offsets = {} as Record<Section, number>;
  let offset = 127;
  for (const name of order) {
    offsets[name] = offset;
    offset += sections[name].length;
  }
  const bytes = new Uint8Array(offset);
  for (const name of order) bytes.set(sections[name], offsets[name]);
  // A section left out of `order` is not in the file: point it at the end
  // of the header (tile data at EOF) so its offset still lies inside.
  writeHeader(bytes, {
    rootDirOffset: offsets.root, rootDirLength: sections.root.length,
    metadataOffset: offsets.metadata ?? 127, metadataLength: sections.metadata.length,
    leafDirectoryOffset: offsets.leaves ?? 127, leafDirectoryLength: sections.leaves.length,
    tileDataOffset: offsets.tiles ?? offset, tileDataLength: sections.tiles.length,
    tileCount: 0, minZoom: 0, maxZoom: 0, compression: parts.compression,
    ...parts.header,
  });
  return bytes;
}

/** Internal-compression codes as PMTiles defines them; 0 and 1 store raw. */
export function compress(bytes: Uint8Array, code: number): Uint8Array {
  if (code === 2) return gzipSync(bytes);
  if (code === 3) return brotliCompressSync(bytes);
  if (code === 4) return zstdCompressSync(bytes);
  return bytes;
}

/** A zstd frame ending with a content checksum, which Node omits by default. */
export function zstdWithChecksum(bytes: Uint8Array): Uint8Array {
  return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

// `prefix` padded with `fill` bytes to `size`, compressed at the fastest
// settings: decompression-bomb blocks of hundreds of MiB stay cheap to build.
export function compressPadded(prefix: Uint8Array, size: number, code: number, fill = 0x20): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(prefix);
  if (code === 2) return gzipSync(bytes, { level: 1 });
  if (code === 3) return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });
  return compress(bytes, code);
}

// Spec: varint count, then per-entry columns — tile-id deltas, run lengths,
// lengths, offsets (offset+1; 0 would mean "previous offset + length").
export function encodeDirectory(entries: { id: number; offset: number; length: number; runLength?: number }[]): Uint8Array {
  const out: number[] = [];
  const varint = (value: number) => {
    while (value >= 0x80) {
      out.push((value % 0x80) + 0x80);
      value = Math.floor(value / 0x80);
    }
    out.push(value);
  };
  varint(entries.length);
  let last = 0;
  for (const e of entries) {
    varint(e.id - last);
    last = e.id;
  }
  for (const e of entries) varint(e.runLength ?? 1);
  for (const e of entries) varint(e.length);
  for (const e of entries) varint(e.offset + 1);
  return Uint8Array.from(out);
}
