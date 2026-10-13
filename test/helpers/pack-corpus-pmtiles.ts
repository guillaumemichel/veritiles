// PMTiles cases for the differential corpus: well-formed archives under
// every internal compression and tile-group budget, adversarial directories
// (run lengths, duplicate and implicit offsets, varint quirks), Node's
// decompression quirks and size cap, metadata JSON edge cases, and every
// parse error.

import { deterministicBytes } from './bytes.ts';
import type { PackCase } from './pack-corpus.ts';
import { assemblePmtiles, compress, compressPadded, encodeDirectory, writePmtilesArchive, zstdWithChecksum, type PmtilesParts, type TileSpec } from './pmtiles-writer.ts';

const NONE = 1;
const GZIP = 2;
const BROTLI = 3;
const ZSTD = 4;
const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

const archiveCase = (name: string, bytes: Uint8Array, args: string[] = []): PackCase => ({
  name: `pmtiles ${name}`,
  inputs: { 'map.pmtiles': bytes },
  args: ['map.pmtiles', '--out', 'proofs', ...args],
});

// `count` tiles filling zooms in order, with lengths from `minLength` up.
function tileSpecs(count: number, minLength: number, spread: number): TileSpec[] {
  const specs: TileSpec[] = [];
  for (let z = 0; specs.length < count; z++) {
    for (let i = 0; i < 4 ** z && specs.length < count; i++) {
      const length = minLength + ((specs.length * 977) % spread);
      specs.push({ z, x: i % 2 ** z, y: Math.floor(i / 2 ** z), data: deterministicBytes(length, specs.length + 7) });
    }
  }
  return specs;
}

const TILES = tileSpecs(40, 50, 3000);

// Raw directory columns, values as stored (offsets are offset+1; 0 means
// "previous offset + length"). Bigints reach past 2^53.
interface Columns {
  count?: number;
  ids: (number | bigint)[];
  runs: number[];
  lengths: (number | bigint)[];
  offsets: (number | bigint)[];
}

function varint(value: number | bigint): number[] {
  const out: number[] = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  return [...out, Number(v)];
}

function rawDirectory(c: Columns): Uint8Array {
  const values = [c.count ?? c.ids.length, ...c.ids, ...c.runs, ...c.lengths, ...c.offsets];
  return Uint8Array.from(values.flatMap(varint));
}

const tileBytes = (length: number) => deterministicBytes(length, length);
const raw = (root: Uint8Array, tiles = 300, parts: Partial<PmtilesParts> = {}) =>
  assemblePmtiles({ root, tiles: tileBytes(tiles), ...parts });
// One 300-byte tile, metadata and directories under `compression`.
const oneTile = encodeDirectory([{ id: 0, offset: 0, length: 300, runLength: 1 }]);
const withMetadata = (metadata: Uint8Array, compression = NONE, root = oneTile) =>
  raw(compress(root, compression), 300, { metadata, compression });

// Leaf directories built by hand: `leaves[i]` are entries of leaf i; the root
// points at `pointers` (indices into leaves, repeats allowed).
function leafArchive(leaves: Columns[], pointers: number[], tiles = 300, compression = NONE): Uint8Array {
  const stored = leaves.map((leaf) => compress(rawDirectory(leaf), compression));
  const starts = stored.map((_, i) => stored.slice(0, i).reduce((n, b) => n + b.length, 0));
  const root = encodeDirectory(pointers.map((i, k) => ({ id: k, offset: starts[i]!, length: stored[i]!.length, runLength: 0 })));
  const metadata = compress(text('{}'), compression);
  return raw(compress(root, compression), tiles, { leaves: concat(...stored), metadata, compression });
}

function wellFormed(): PackCase[] {
  const leafy = (compression: number) => writePmtilesArchive(TILES, { rootEntriesPerLeaf: 7, compression }).bytes;
  const many = writePmtilesArchive(tileSpecs(4000, 1, 20), { rootEntriesPerLeaf: 500, compression: GZIP }).bytes;
  // About 1 MB of tiles: 16, 32 and 64 KiB groups cut it differently.
  const grouped = writePmtilesArchive(tileSpecs(400, 1500, 2000)).bytes;
  // The planet's layout: tile data first, then metadata and leaf directories.
  const tailLeaf = encodeDirectory([0, 1, 2, 5, 6].map((id, i) => ({ id, offset: i * 100, length: 100 })));
  const tailRoot = encodeDirectory([{ id: 0, offset: 0, length: tailLeaf.length, runLength: 0 }]);
  const planetLayout = raw(tailRoot, 500, { leaves: tailLeaf, order: ['root', 'tiles', 'metadata', 'leaves'] });
  return [
    archiveCase('auto profile', writePmtilesArchive(TILES).bytes),
    archiveCase('explicit profile', writePmtilesArchive(TILES).bytes, ['--profile', 'pmtiles']),
    archiveCase('fixed profile override', writePmtilesArchive(TILES).bytes, ['--profile', 'fixed', '--chunk', '4KiB']),
    archiveCase('leaf directories', leafy(NONE)),
    ...[0, 1, 8192].map((budget) => archiveCase(`tile-group ${budget}`, leafy(NONE), ['--tile-group', `${budget}`])),
    archiveCase('tile-group 1MiB explicit', leafy(NONE), ['--tile-group', '1MiB']),
    archiveCase('400 tiles, default tile group', grouped),
    ...['16KiB', '32KiB', '64KiB'].map((budget) => archiveCase(`400 tiles, tile-group ${budget}`, grouped, ['--tile-group', budget])),
    ...[0, GZIP, BROTLI, ZSTD].map((code) => archiveCase(`compression ${code}`, leafy(code))),
    archiveCase('4000 tiles, ungrouped (multi-shard band)', many, ['--tile-group', '0']),
    archiveCase('4000 tiles, grouped', many),
    archiveCase('metadata after tile data', raw(oneTile, 300, { order: ['root', 'leaves', 'tiles', 'metadata'] })),
    archiveCase('planet layout, ungrouped', planetLayout, ['--tile-group', '0']),
    archiveCase('planet layout, grouped', planetLayout),
    archiveCase('--unixfs', leafy(GZIP), ['--unixfs']),
    archiveCase('--unixfs, full CAR over several chunks', grouped, ['--unixfs', '--full-car', 'pin.car']),
    archiveCase('--chunk (error)', leafy(NONE), ['--chunk', '1KiB']),
    archiveCase('wrong version falls back to fixed', concat(text('PMTiles'), Uint8Array.of(2), tileBytes(200))),
    archiveCase('truncated header (error)', concat(text('PMTiles'), Uint8Array.of(3), tileBytes(100))),
  ];
}

function directories(): PackCase[] {
  const columns = (ids: number[], runs: number[], lengths: number[], offsets: number[]) => rawDirectory({ ids, runs, lengths, offsets });
  return [
    archiveCase('run lengths', raw(columns([0, 1, 4], [1, 3, 2], [100, 100, 100], [1, 101, 201]))),
    archiveCase('duplicate offsets', raw(columns([0, 1, 1, 1], [1, 1, 1, 1], [100, 100, 200, 100], [1, 1, 101, 201]))),
    archiveCase('same offset, different lengths', raw(columns([0, 1, 1], [1, 1, 1], [200, 100, 100], [1, 1, 201]), 300, {}), ['--tile-group', '0']),
    archiveCase('implicit offsets', raw(columns([0, 1, 1, 1], [1, 1, 1, 1], [50, 50, 100, 100], [1, 0, 0, 0]))),
    archiveCase('overlapping and zero-length tiles', raw(columns([0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [300, 0, 50, 0, 100], [1, 51, 101, 301, 201])), ['--tile-group', '0']),
    archiveCase('only a zero-length tile', raw(columns([0], [1], [0], [1]), 0)),
    archiveCase('zoom 26/27 boundary ids', raw(rawDirectory({ ids: [6004799503160660, 1, 3002399751580330], runs: [1, 1, 1], lengths: [100, 100, 100], offsets: [1, 101, 201] }))),
    archiveCase('10-byte varint keeps only bit 0', raw(concat(Uint8Array.of(1), Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7e), Uint8Array.of(1, 0xac, 0x02, 1)))),
    archiveCase('trailing directory bytes ignored', raw(concat(oneTile, tileBytes(9)))),
    archiveCase('leaf directories, duplicate pointers', leafArchive([
      { ids: [0, 1], runs: [1, 1], lengths: [100, 100], offsets: [1, 101] },
      { ids: [2], runs: [1], lengths: [100], offsets: [201] },
    ], [0, 1, 0, 1, 1])),
    archiveCase('leaf pointer offset from a -1 tile offset (error)', implicitAfterMinusOne(oneTile)),
    archiveCase('leaf errors outrank earlier tile errors (error)', implicitAfterMinusOne(Uint8Array.of(0))),
  ];
}

// Root entry 0 is a tile at offset -1 (stored 0); entry 1, a leaf pointer
// with an implicit offset, then lands at -1 + 5 = 4 inside the leaf section.
function implicitAfterMinusOne(leaf: Uint8Array): Uint8Array {
  const root = rawDirectory({ ids: [0, 1], runs: [1, 0], lengths: [5, leaf.length], offsets: [0, 0] });
  return raw(root, 300, { leaves: concat(new Uint8Array(4), leaf) });
}

function directoryErrors(): PackCase[] {
  const one = (fields: Partial<Columns>) => raw(rawDirectory({ ids: [0], runs: [1], lengths: [300], offsets: [1], ...fields }));
  const leaf = (entries: Columns) => leafArchive([entries], [0]);
  return [
    archiveCase('gap in tile data (error)', raw(rawDirectory({ ids: [0, 1], runs: [1, 1], lengths: [100, 100], offsets: [1, 201] }))),
    archiveCase('nested leaf directory (error)', leaf({ ids: [0, 1], runs: [1, 0], lengths: [100, 5], offsets: [1, 1] })),
    archiveCase('root beyond 16 KiB (error)', raw(oneTile, 300, { pad: new Uint8Array(16384), order: ['pad', 'root', 'metadata', 'tiles'] })),
    archiveCase('empty root directory (error)', raw(Uint8Array.of(0))),
    archiveCase('empty leaf directory (error)', leafArchive([{ ids: [], runs: [], lengths: [], offsets: [] }], [0])),
    archiveCase('zero-length root (error)', raw(new Uint8Array(0))),
    archiveCase('truncated count varint (error)', raw(Uint8Array.of(0x81))),
    archiveCase('missing columns (error)', raw(Uint8Array.of(2, 0, 1, 1, 1))),
    archiveCase('11-byte varint (error)', raw(concat(Uint8Array.of(1), new Uint8Array(10).fill(0x80), Uint8Array.of(0)))),
    archiveCase('tile length over 0xffffffff (error)', one({ lengths: [2 ** 32] })),
    archiveCase('tile id 2^53 (error)', one({ ids: [2n ** 53n] })),
    archiveCase('tile id 2^64-1 (error)', one({ ids: [2n ** 64n - 1n] })),
    archiveCase('run length checked before tile id (error)', leaf({ ids: [2n ** 53n], runs: [0], lengths: [5], offsets: [1] })),
    archiveCase('tile id checked before length (error)', one({ ids: [2n ** 53n], lengths: [2 ** 32] })),
    archiveCase('first offset implicit (error)', one({ offsets: [0] })),
    archiveCase('leaf pointer with implicit first offset (error)', raw(rawDirectory({ ids: [0], runs: [0], lengths: [5], offsets: [0] }))),
    archiveCase('tile outside tile data (error)', one({ lengths: [301] })),
    archiveCase('tile offset 2^60 (error)', one({ offsets: [2n ** 60n] })),
    archiveCase('leaf outside archive (error)', raw(rawDirectory({ ids: [0], runs: [0], lengths: [5000], offsets: [1] }))),
    archiveCase('metadata outside archive (error)', raw(oneTile, 300, { header: { metadataLength: 100000 } })),
    archiveCase('root offset 2^60 (error)', raw(oneTile, 300, { header: { rootDirOffset: 2 ** 60 } })),
    archiveCase('compression 5 (error)', raw(oneTile, 300, { compression: 5 })),
    archiveCase('compression 255 (error)', raw(oneTile, 300, { compression: 255 })),
  ];
}

function decompression(): PackCase[] {
  const gz = compress(oneTile, GZIP);
  const meta = (code: number) => compress(text('{"a":1}'), code);
  const zstd16KiB = compress(text(`{"pad":"${' '.repeat(16384 - 10)}"}`), ZSTD);
  const zstdChecked = zstdWithChecksum(text('{"a":1}'));
  return [
    archiveCase('gzip trailing zeros', raw(concat(gz, new Uint8Array(4)), 300, { compression: GZIP, metadata: meta(GZIP) })),
    archiveCase('gzip root + zero + junk', raw(concat(gz, Uint8Array.of(0, 0x41, 0x42)), 300, { compression: GZIP, metadata: meta(GZIP) })),
    archiveCase('gzip root + trailing junk (error)', raw(concat(gz, text('junk')), 300, { compression: GZIP, metadata: meta(GZIP) })),
    archiveCase('gzip multi-member metadata', withMetadata(concat(compress(text('{"a"'), GZIP), compress(text(':1}'), GZIP)), GZIP)),
    archiveCase('gzip truncated metadata (error)', withMetadata(meta(GZIP).subarray(0, 15), GZIP)),
    archiveCase('gzip empty metadata (error)', withMetadata(new Uint8Array(0), GZIP)),
    archiveCase('brotli trailing junk', withMetadata(concat(meta(BROTLI), text('junk')), BROTLI)),
    archiveCase('brotli truncated metadata (error)', withMetadata(meta(BROTLI).subarray(0, 3), BROTLI)),
    // A zstd block is exactly one complete frame: Node 22 and 24 disagree
    // on truncated frames and on bytes after a frame.
    archiveCase('zstd metadata of exactly 16 KiB', withMetadata(zstd16KiB, ZSTD)),
    archiveCase('zstd frame with checksum', withMetadata(zstdChecked, ZSTD)),
    archiveCase('zstd checksum cut short (error)', withMetadata(zstdChecked.subarray(0, zstdChecked.length - 1), ZSTD)),
    archiveCase('zstd second frame (error)', withMetadata(concat(meta(ZSTD), compress(text('junk'), ZSTD)), ZSTD)),
    archiveCase('zstd trailing junk (error)', withMetadata(concat(meta(ZSTD), text('junk')), ZSTD)),
    archiveCase('zstd 16 KiB frame + second frame (error)', withMetadata(concat(zstd16KiB, compress(text('x'), ZSTD)), ZSTD)),
    archiveCase('zstd skippable frame first (error)', withMetadata(concat(Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 9), meta(ZSTD)), ZSTD)),
    archiveCase('zstd truncated metadata (error)', withMetadata(meta(ZSTD).subarray(0, meta(ZSTD).length - 2), ZSTD)),
    archiveCase('zstd garbage (error)', withMetadata(text('not zstd at all'), ZSTD)),
    archiveCase('zstd empty root (error)', raw(new Uint8Array(0), 300, { compression: ZSTD, metadata: meta(ZSTD) })),
  ];
}

const CAP = 256 * 1024 * 1024;

// Every decompressed block is capped at 256 MiB: exactly the cap decodes,
// one byte more fails. Metadata is `{}` padded with spaces; directories are
// padded with ignored zero bytes.
function decompressionCap(): PackCase[] {
  const json = text('{}');
  const codecs: [string, number][] = [['gzip', GZIP], ['brotli', BROTLI], ['zstd', ZSTD]];
  const leaf = compressPadded(oneTile, CAP + 1, GZIP, 0);
  const leafRoot = encodeDirectory([{ id: 0, offset: 0, length: leaf.length, runLength: 0 }]);
  return [
    ...codecs.flatMap(([name, code]) => [
      archiveCase(`${name} metadata of 256 MiB`, withMetadata(compressPadded(json, CAP, code), code)),
      archiveCase(`${name} metadata of 256 MiB + 1 (error)`, withMetadata(compressPadded(json, CAP + 1, code), code)),
    ]),
    archiveCase('zstd root of 256 MiB + 1 (error)', raw(compressPadded(oneTile, CAP + 1, ZSTD, 0), 300, { compression: ZSTD, metadata: compress(json, ZSTD) })),
    archiveCase('gzip leaf of 256 MiB + 1 (error)', raw(compress(leafRoot, GZIP), 300, { leaves: leaf, compression: GZIP, metadata: compress(json, GZIP) })),
  ];
}

// A leaf directory too large to spread into Array.prototype.push.
function manyEntries(): PackCase[] {
  const count = 200_000;
  const ones = new Array<number>(count - 1).fill(1);
  const leaf = { ids: [0, ...ones], runs: [1, ...ones], lengths: [1, ...ones], offsets: [1, ...ones.map(() => 0)] };
  return [archiveCase('200,000-entry leaf directory', leafArchive([leaf], [0], count))];
}

const JSON_CASES: [string, string | Uint8Array][] = [
  ['BOM', '﻿{"a":1}'],
  ['two BOMs (error)', '﻿﻿{}'],
  ['lone surrogate escape', '{"a":"\\ud800"}'],
  ['every escape', '{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uABCD"}'],
  ['1e400', '{"a":1e400,"b":-0.5E-3,"c":[true,false,null]}'],
  ['deep nesting 10000', `{"a":${'['.repeat(10000)}${']'.repeat(10000)}}`],
  ['unbalanced nesting (error)', `{"a":${'['.repeat(10000)}${']'.repeat(9999)}}`],
  ['whitespace', ' \t\r\n{ "a" : [ 1 , 2 ] } \n'],
  ['invalid UTF-8 inside a string', concat(text('{"a":"'), Uint8Array.of(0xff, 0xe2, 0x82), text('"}'))],
  ['invalid UTF-8 outside strings (error)', concat(text('{"a":1}'), Uint8Array.of(0xff))],
  ['array (error)', '[]'],
  ['null (error)', 'null'],
  ['number (error)', '42'],
  ['string (error)', '"x"'],
  ['empty (error)', ''],
  ['truncated (error)', '{"a":'],
  ['trailing garbage (error)', '{} x'],
  ['trailing comma (error)', '{"a":1,}'],
  ['leading zero (error)', '{"a":01}'],
  ['bare minus (error)', '{"a":-}'],
  ['dot without digits (error)', '{"a":1.}'],
  ['short unicode escape (error)', '{"a":"\\u12"}'],
  ['unknown escape (error)', '{"a":"\\x"}'],
  ['control character in string (error)', '{"a":"\t"}'],
  ['single quotes (error)', "{'a':1}"],
  ['missing colon (error)', '{"a" 1}'],
  ['bad literal (error)', '{"a":tru}'],
  ['non-string key (error)', '{1:1}'],
];

function metadataJson(): PackCase[] {
  return JSON_CASES.map(([name, value]) => archiveCase(`metadata ${name}`, withMetadata(typeof value === 'string' ? text(value) : value)));
}

export function pmtilesCorpus(): PackCase[] {
  return [...wellFormed(), ...directories(), ...directoryErrors(), ...decompression(), ...decompressionCap(), ...manyEntries(), ...metadataJson()];
}
