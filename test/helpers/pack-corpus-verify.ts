// `pack verify` cases for the differential corpus. Packages are packed by
// each CLI first, then verified by both: TS output by Rust and Rust output
// by TS. Tampered packages must fail in both; the two verifiers word their
// errors differently, so those cases compare exit status and stdout only.
// TS verify spot-reads, so every tampered byte sits where its reads land: a
// one-leaf file, a one-shard tree, or the meta over the first half of a file.

import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { deterministicBytes, flipByte } from './bytes.ts';
import { box, concat, fragment } from './mp4-writer.ts';
import type { PackCase } from './pack-corpus.ts';
import { runPacker } from './pack-runner.ts';
import { writePmtilesArchive } from './pmtiles-writer.ts';

interface Package {
  anchor: string;
  input: Uint8Array;
  proofs: Record<string, Uint8Array>;
}

// 1,599 shards of 1-byte leaves: one past the top-meta limit, so the band
// splits into two directories, the first 800 shards under `0/meta`.
const META_DIR_SIZE = 1599 * 1820 - 1819;

async function packWith(command: string[], input: Uint8Array, args: string[]): Promise<Package> {
  const run = await runPacker(command, { name: 'package', inputs: { 'input.bin': input }, args: ['input.bin', '--out', 'proofs', ...args] });
  if (run.status !== 0) throw new Error(`packing failed: ${run.stderr}`);
  const proofs = Object.fromEntries([...run.files].filter(([path]) => path.startsWith('proofs/')));
  return { anchor: run.stdout.trim(), input, proofs };
}

interface Edit { input?: Uint8Array; proofs?: Record<string, Uint8Array>; cid?: string; file?: string }

const verifyCase = (name: string, pkg: Package, edit: Edit = {}): PackCase => ({
  name: `verify ${name}`,
  inputs: { 'input.bin': edit.input ?? pkg.input, ...(edit.proofs ?? pkg.proofs) },
  args: ['verify', '--cid', edit.cid ?? pkg.anchor, '--file', edit.file ?? 'input.bin', '--proofs', 'proofs'],
  ...(name.endsWith('(error)') ? { statusOnly: true } : {}),
});

const withProof = (pkg: Package, path: string, bytes?: Uint8Array) => {
  const proofs = { ...pkg.proofs };
  if (bytes === undefined) delete proofs[path];
  else proofs[path] = bytes;
  return { proofs };
};

// Zooms 0-2, every tile distinct.
const PMTILES = writePmtilesArchive([0, 1, 2].flatMap((z) => Array.from({ length: 4 ** z }, (_, i) => ({
  z, x: i % 2 ** z, y: Math.floor(i / 2 ** z), data: deterministicBytes(40 + i * 101 + z * 7, z * 100 + i + 1),
})))).bytes;

// An init leaf, one leaf per fragment, and an mfra tail leaf.
const MP4 = concat(box('ftyp', 16), box('moov', 400), ...[3000, 9000, 500].map((size) => fragment(60, size)), box('mfra', 30));

const KINDS: [string, Uint8Array, string[]][] = [
  ['fixed', deterministicBytes(5000, 11), ['--chunk', '1']],
  ['pmtiles', PMTILES, ['--tile-group', '1KiB']],
  ['mp4', MP4, []],
  ['unixfs', deterministicBytes(600_000, 12), ['--unixfs', '--chunk', '100KiB']],
];

export async function verifyCorpus(packers: Record<string, string[]>): Promise<PackCase[]> {
  const byPacker = Object.entries(packers).flatMap(([packer, command]) =>
    KINDS.map(async ([kind, input, args]) => verifyCase(`${kind}, packed by ${packer}`, await packWith(command, input, args))));
  const ts = packers.ts!;
  const [kindCases, [leaf, shard, metaDir]] = await Promise.all([Promise.all(byPacker), Promise.all([
    packWith(ts, deterministicBytes(300_000, 13), []),
    packWith(ts, deterministicBytes(4000, 14), ['--chunk', '7']),
    packWith(ts, deterministicBytes(META_DIR_SIZE, 15), ['--chunk', '1']),
  ])]);
  const length = leaf.input.length;
  return [
    ...kindCases,
    verifyCase('one-leaf package', leaf),
    verifyCase('meta directory', metaDir),
    // Proof files are read on demand: a stray dangling symlink is never read.
    { ...verifyCase('dangling symlink among the proofs', leaf), setup: (dir) => symlink('nowhere', join(dir, 'proofs/dangling')) },
    verifyCase('flipped content byte (error)', leaf, { input: flipByte(leaf.input, 150_000) }),
    verifyCase('truncated file (error)', leaf, { input: leaf.input.subarray(0, length - 1) }),
    verifyCase('extra trailing byte (error)', leaf, { input: Uint8Array.from([...leaf.input, 0]) }),
    verifyCase('flipped shard byte (error)', shard, withProof(shard, 'proofs/0', flipByte(shard.proofs['proofs/0']!, 40))),
    verifyCase('missing shard (error)', shard, withProof(shard, 'proofs/0')),
    verifyCase('flipped meta byte (error)', metaDir, withProof(metaDir, 'proofs/0/meta', flipByte(metaDir.proofs['proofs/0/meta']!, 9))),
    verifyCase('flipped root byte (error)', leaf, withProof(leaf, 'proofs/root', flipByte(leaf.proofs['proofs/root']!, 20))),
    verifyCase('missing root (error)', leaf, withProof(leaf, 'proofs/root')),
    verifyCase('another package\'s anchor (error)', leaf, { cid: shard.anchor }),
    verifyCase('malformed anchor (error)', leaf, { cid: 'bnot-base32' }),
    verifyCase('raw anchor (error)', leaf, { cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' }),
    verifyCase('missing file (error)', leaf, { file: 'absent.bin' }),
    { name: 'verify without --proofs (error)', inputs: {}, args: ['verify', '--cid', leaf.anchor, '--file', 'input.bin'] },
  ];
}
