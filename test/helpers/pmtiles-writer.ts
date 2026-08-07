// Minimal PMTiles v3 writer — just enough archive for the real `pmtiles`
// reader to open: uncompressed directories and tiles (internal_compression
// and tile_compression both None). It can emit direct root entries or
// root-referenced leaf directories for publisher tests.

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
      const leaf = serializeDirectory(leafEntries);
      rootEntries.push({ id: leafEntries[0]!.id, offset: leafDirectories.reduce((n, b) => n + b.length, 0), length: leaf.length, runLength: 0 });
      leafDirectories.push(leaf);
    }
  } else {
    rootEntries = placed.map((e) => ({ ...e, runLength: 1 }));
  }
  const encodedRoot = serializeDirectory(rootEntries);
  const metadataBytes = new TextEncoder().encode('{}');
  const rootDirOffset = 127;
  const metadataOffset = rootDirOffset + encodedRoot.length;
  const leafDirectoryOffset = metadataOffset + metadataBytes.length;
  const leafDirectoryLength = leafDirectories.reduce((n, b) => n + b.length, 0);
  const tileDataOffset = leafDirectoryOffset + leafDirectoryLength;
  const tileDataLength = offset;

  const bytes = new Uint8Array(tileDataOffset + tileDataLength);
  const dv = new DataView(bytes.buffer);
  const u64 = (pos: number, value: number) => dv.setBigUint64(pos, BigInt(value), true);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]); // "PMTiles"
  bytes[7] = 3; // spec version
  u64(8, rootDirOffset);
  u64(16, encodedRoot.length);
  u64(24, metadataOffset);
  u64(32, metadataBytes.length);
  u64(40, leafDirectoryOffset);
  u64(48, leafDirectoryLength);
  u64(56, tileDataOffset);
  u64(64, tileDataLength);
  u64(72, tiles.length); // addressed tiles
  u64(80, placed.length); // tile entries
  u64(88, placed.length); // tile contents
  bytes[96] = 1; // clustered
  bytes[97] = 1; // internal_compression: none
  bytes[98] = 1; // tile_compression: none
  bytes[99] = 1; // tile_type: mvt
  bytes[100] = Math.min(...tiles.map((t) => t.z));
  bytes[101] = Math.max(...tiles.map((t) => t.z));
  dv.setInt32(102, -180e7, true); // min lon (e7)
  dv.setInt32(106, -85e7, true); // min lat
  dv.setInt32(110, 180e7, true); // max lon
  dv.setInt32(114, 85e7, true); // max lat
  bytes[118] = bytes[100]!; // center zoom
  dv.setInt32(119, 0, true); // center lon
  dv.setInt32(123, 0, true); // center lat

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

// Spec: varint count, then per-entry columns — tile-id deltas, run lengths,
// lengths, offsets (offset+1; 0 would mean "previous offset + length").
function serializeDirectory(entries: { id: number; offset: number; length: number; runLength?: number }[]): Uint8Array {
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
