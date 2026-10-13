// The differential corpus for test/pack-diff.test.ts: each case is a set of
// input files plus the argument list both packers run with, from a fresh
// working directory holding those inputs. Paths are relative, so outputs and
// messages compare byte for byte. Verify cases need packed inputs, so they
// are built asynchronously by pack-corpus-verify.ts.

import { link, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { deterministicBytes } from './bytes.ts';
import { assetsCorpus } from './pack-corpus-assets.ts';
import { mp4Corpus } from './pack-corpus-mp4.ts';
import { pmtilesCorpus } from './pack-corpus-pmtiles.ts';

export interface PackCase {
  name: string;
  inputs: Record<string, Uint8Array>;
  args: string[];
  /** Runs after the inputs are written: symlinks, odd names, empty directories. */
  setup?: (dir: string) => Promise<void>;
  /** Compare exit status, stdout, and files only: the verifiers word errors differently. */
  statusOnly?: boolean;
}

const KiB = 1024;
const CHUNK = 256 * KiB;

const sized = (name: string, size: number, args: string[] = []): PackCase => ({
  name,
  inputs: { 'input.bin': deterministicBytes(size, size + 1) },
  args: ['input.bin', '--out', 'proofs', ...args],
});

const UNIXFS = ['--unixfs'];
const FULL_CAR = ['--unixfs', '--full-car', 'pin.car'];

// --unixfs around the balanced tree's edges: one chunk, one full parent
// (174 chunks), and the first two-level trees.
function unixfsCases(): PackCase[] {
  const sizes: [string, number][] = [
    ['1 B', 1],
    ['256 KiB - 1', CHUNK - 1],
    ['256 KiB', CHUNK],
    ['256 KiB + 1', CHUNK + 1],
    ['174 chunks - 1', 174 * CHUNK - 1],
    ['174 chunks', 174 * CHUNK],
    ['174 chunks + 1', 174 * CHUNK + 1],
    ['175 chunks', 175 * CHUNK],
    ['349 chunks + 7', 349 * CHUNK + 7],
  ];
  const zeros = new Uint8Array(360 * CHUNK);
  return [
    ...sizes.flatMap(([label, size]) => [sized(`unixfs ${label}`, size, UNIXFS), sized(`unixfs ${label}, full CAR`, size, FULL_CAR)]),
    // Repeated leaves and repeated parents: each written to the CAR once.
    { name: 'unixfs all zeros, full CAR', inputs: { 'input.bin': zeros }, args: ['input.bin', '--out', 'proofs', ...FULL_CAR] },
    sized('unixfs, full CAR inside the proofs directory', 3 * CHUNK, ['--unixfs', '--full-car', 'proofs/pin.car']),
    sized('unixfs, full CAR in a missing directory (error)', 3 * CHUNK, ['--unixfs', '--full-car', 'missing/pin.car']),
    // The CAR is opened before `root` is written, so `root/` does not exist yet.
    sized('unixfs, full CAR under a proof file (error)', 10, ['--unixfs', '--full-car', 'proofs/root/pin.car']),
    sized('full CAR without --unixfs (error)', 10, ['--full-car', 'pin.car']),
    // A proof file that cannot be written: the CAR's `.tmp` is removed.
    { ...sized('unixfs, full CAR, proof write fails (error)', 3 * CHUNK, FULL_CAR), setup: async (dir) => { await mkdir(join(dir, 'proofs', '0'), { recursive: true }); } },
    // Outputs that already are the input file, reached by a symlink or a hardlink.
    { name: 'full CAR .tmp is the input via a symlink (error)', inputs: { 'in.tmp': deterministicBytes(3 * CHUNK, 2) }, args: ['in.tmp', '--unixfs', '--full-car', 'l/in'], setup: (dir) => symlink('.', join(dir, 'l')) },
    { ...sized('proof file is the input via a hardlink (error)', 3 * CHUNK, FULL_CAR), setup: async (dir) => { await mkdir(join(dir, 'proofs')); await link(join(dir, 'input.bin'), join(dir, 'proofs', '0')); } },
  ];
}

export function packCorpus(): PackCase[] {
  return [
    sized('size 0 (error)', 0),
    sized('size 1', 1),
    sized('256 KiB - 1', CHUNK - 1, ['--chunk', '256KiB']),
    sized('256 KiB', CHUNK, ['--chunk', '256KiB']),
    sized('256 KiB + 1', CHUNK + 1, ['--chunk', '256KiB']),
    sized('1 MiB + 1, default chunk', 4 * CHUNK + 1),
    sized('chunk 1 across shards', 4000, ['--chunk', '1']),
    // 1,599 shards, one past the top-meta limit: the band splits into five
    // directories of 320, 320, 320, 320 and 319 shards.
    sized('chunk 1, band split into directories', 1599 * 1820 - 1819, ['--chunk', '1']),
    sized('chunk 7', 20_000, ['--chunk', '7']),
    { name: 'all zeros', inputs: { 'input.bin': new Uint8Array(3 * CHUNK + 5) }, args: ['input.bin', '--out', 'proofs', '--chunk', '256KiB'] },
    sized('unixfs + full CAR', 3 * CHUNK + 9, FULL_CAR),
    ...unixfsCases(),
    sized('chunk 0 (error)', 10, ['--chunk', '0']),
    sized('unknown flag (error)', 10, ['--bogus']),
    sized('pmtiles on a plain file (error)', 10, ['--profile', 'pmtiles']),
    sized('tile-group on fixed (error)', 10, ['--tile-group', '1KiB']),
    sized('full CAR over the input (error)', 10, ['--unixfs', '--full-car', 'input.bin']),
    { name: 'full CAR .tmp over the input (error)', inputs: { 'pin.car.tmp': deterministicBytes(10, 1) }, args: ['pin.car.tmp', '--unixfs', '--full-car', 'pin.car'] },
    { name: 'out containing the input (error)', inputs: { 'data/input.bin': deterministicBytes(10, 1) }, args: ['data/input.bin', '--out', 'data'] },
    // Node's recursive mkdir: an existing non-directory parent is ENOTDIR, named by its own path.
    { ...sized('out under a dangling symlink (error)', 10), args: ['input.bin', '--out', 'l/x'], setup: (dir) => symlink('nowhere', join(dir, 'l')) },
    { name: 'out . containing the input (error)', inputs: { 'input.bin': deterministicBytes(10, 1) }, args: ['input.bin', '--out', '.'] },
    ...pmtilesCorpus(),
    ...mp4Corpus(),
    ...assetsCorpus(),
  ];
}
