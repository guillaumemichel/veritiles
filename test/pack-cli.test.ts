// The pack CLI is strict: every flag, value, and positional it does not use
// is an error, and it never writes over its own input.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCid } from '../packages/anymirror/src/cid.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { box, concat, fragment } from './helpers/mp4-writer.ts';
import { writePmtilesArchive } from './helpers/pmtiles-writer.ts';

const packTool = fileURLToPath(new URL('../tools/pack.ts', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'anymirror-pack-cli-'));
after(() => rm(dir, { recursive: true, force: true }));
const plain = join(dir, 'plain.bin');
const archive = join(dir, 'map.pmtiles');
const video = join(dir, 'video.mp4');
await writeFile(plain, deterministicBytes(5000, 1));
await writeFile(archive, writePmtilesArchive([{ z: 0, x: 0, y: 0, data: deterministicBytes(300, 2) }]).bytes);
await writeFile(video, concat(box('ftyp', 16), box('moov', 300), fragment(50, 1000), fragment(50, 2000)));

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [packTool, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fails(args: string[], message: string): void {
  const result = run(...args);
  assert.equal(result.status, 1, `${args.join(' ')} must fail`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${message}\n`);
}

test('C-01 unknown flags, missing values, and extra positionals are errors', () => {
  fails([plain, '--bogus'], 'unknown flag --bogus');
  fails([plain, '--out'], '--out requires a value');
  fails([plain, '--out', '--unixfs'], '--out requires a value');
  fails([plain, '--out', ''], '--out requires a value');
  fails([plain, 'extra'], 'unexpected argument extra');
  fails([plain, '--unixfs', 'extra'], 'unexpected argument extra');
  fails(['assets', dir, '--profile', 'fixed'], 'unknown flag --profile');
  fails(['assets', dir, 'extra'], 'unexpected argument extra');
  fails(['verify', '--cid', 'x', '--file', plain, '--proofs', dir, '--reads', '3'], 'unknown flag --reads');
});

test('C-02 usage errors name the command', () => {
  fails([], 'usage: pack <input> [--profile auto|fixed|pmtiles|mp4] [--chunk N] [--tile-group N] [--unixfs] [--full-car pin.car] [--out dir]');
  fails(['assets'], 'usage: pack assets <dir> [--out bundle.car] [--type ext=mime]');
  fails(['verify', '--cid', 'x'], 'usage: pack verify --cid <anchor> --file <path> --proofs <dir>');
});

test('C-03 profile and size flags are checked against the input', () => {
  fails([plain, '--chunk', '0'], 'bad chunk size: 0');
  fails([plain, '--chunk', '99999999999999999999'], 'bad --chunk value: 99999999999999999999');
  fails([plain, '--profile', 'bogus'], 'unknown profile: bogus');
  fails([plain, '--profile', 'pmtiles'], 'not a PMTiles v3 archive');
  fails([plain, '--tile-group', '0'], '--tile-group applies only to the pmtiles profile');
  fails([archive, '--chunk', '1KiB'], '--chunk applies only to the fixed profile');
  fails([archive, '--profile', 'fixed', '--tile-group', '1KiB'], '--tile-group applies only to the pmtiles profile');
  fails([plain, '--profile', 'mp4'], 'MP4 box at 0 extends past the end of the file');
  fails([video, '--chunk', '1KiB'], '--chunk applies only to the fixed profile');
  fails([video, '--profile', 'mp4', '--tile-group', '1KiB'], '--tile-group applies only to the pmtiles profile');
  fails([plain, '--full-car', join(dir, 'x.car')], '--full-car requires --unixfs');
});

test('C-04 outputs that resolve to the input are refused', async () => {
  fails([plain, '--unixfs', '--full-car', plain], '--full-car resolves to the input file');
  fails([plain, '--unixfs', '--full-car', `${dir}/../${dir.split('/').at(-1)}/plain.bin`], '--full-car resolves to the input file');
  fails([plain, '--out', plain], '--out resolves to the input file');
  // The CAR is written to `<path>.tmp` first; that must not be the input either.
  const tmpInput = join(dir, 'pin.car.tmp');
  await writeFile(tmpInput, deterministicBytes(10, 3));
  fails([tmpInput, '--unixfs', '--full-car', join(dir, 'pin.car')], '--full-car resolves to the input file');
  fails([plain, '--out', dir], '--out contains the input file');
  fails([plain, '--out', join(dir, '..')], '--out contains the input file');
});

test('C-06 the full CAR is opened before any proof file is written', async () => {
  const out = join(dir, 'c06');
  // `root` becomes a file, so a CAR under it can only be opened beforehand.
  fails([plain, '--unixfs', '--full-car', join(out, 'root', 'pin.car'), '--out', out], `ENOENT: no such file or directory, open '${join(out, 'root', 'pin.car')}.tmp'`);
  assert.ok(existsSync(join(out, 'root')), 'proof files are still written');
});

test('C-08 a failed pack leaves no CAR .tmp behind', async () => {
  const out = join(dir, 'c08');
  await mkdir(join(out, '0'), { recursive: true });
  const car = join(dir, 'c08.car');
  fails([plain, '--unixfs', '--full-car', car, '--out', out], `EISDIR: illegal operation on a directory, open '${out}/0'`);
  assert.ok(!existsSync(`${car}.tmp`), 'the temporary CAR is removed');
});

test('C-09 outputs that are the input file are refused, however reached', async () => {
  const before = await readFile(plain);
  const c09 = join(dir, 'c09');
  await mkdir(join(c09, 'p'), { recursive: true });
  await mkdir(join(c09, 'q'));
  await link(plain, join(c09, 'c.car.tmp'));
  await symlink(dir, join(c09, 'l'));
  await link(plain, join(c09, 'p', '0'));
  await symlink(plain, join(c09, 'q', 'root'));
  fails([plain, '--unixfs', '--full-car', join(c09, 'c.car'), '--out', join(c09, 'o1')], '--full-car resolves to the input file');
  await writeFile(join(dir, 'c09x.tmp'), before);
  fails([join(dir, 'c09x.tmp'), '--unixfs', '--full-car', join(c09, 'l', 'c09x'), '--out', join(c09, 'o2')], '--full-car resolves to the input file');
  fails([plain, '--unixfs', '--full-car', join(c09, 'c2.car'), '--out', join(c09, 'p')], '--out contains the input file');
  fails([plain, '--out', join(c09, 'q')], '--out contains the input file');
  assert.deepEqual(await readFile(plain), before);
  assert.ok(!existsSync(join(c09, 'c2.car.tmp')), 'the CAR is not opened');
});

test('C-07 verify reads only the proof files it needs', async () => {
  const out = join(dir, 'c07');
  const packed = run(plain, '--chunk', '1KiB', '--out', out);
  assert.equal(packed.status, 0, packed.stderr);
  await symlink('nowhere', join(out, 'dangling'));
  await mkdir(join(out, 'unrelated'));
  const verified = run('verify', '--cid', packed.stdout.trim(), '--file', plain, '--proofs', out);
  assert.equal(verified.status, 0, verified.stderr);
});

test('C-05 pack writes proofs and the full CAR atomically, then verifies', async () => {
  const car = join(dir, 'pin.car');
  const out = join(dir, 'proofs');
  const packed = run(plain, '--chunk', '1KiB', '--unixfs', '--full-car', car, '--out', out);
  assert.equal(packed.status, 0, packed.stderr);
  assert.ok((await readFile(car)).length > 5000);
  assert.ok(!existsSync(`${car}.tmp`), 'the temporary CAR is renamed away');
  assert.ok(existsSync(join(out, 'root')));
  const verified = run('verify', '--cid', packed.stdout.trim(), '--file', plain, '--proofs', out);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, 'verify OK\n');
});

test('C-10 a PMTiles pack reports its tile group, chosen or explicit', () => {
  const chosen = run(archive, '--out', join(dir, 'c10a'));
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stderr, /^proofs: .*\ntile group: 16384 bytes\nmap: [^\n]+\n$/);
  const explicit = run(archive, '--tile-group', '0', '--out', join(dir, 'c10b'));
  assert.match(explicit.stderr, /^proofs: .*\ntile group: 0 bytes\nmap: [^\n]+\n$/);
  const fixed = run(plain, '--out', join(dir, 'c10c'));
  assert.match(fixed.stderr, /^proofs: .*\nmap: [^\n]+\n$/);
});

test('C-11 an mp4 pack reports one leaf per fragment and no tile group', () => {
  const packed = run(video, '--out', join(dir, 'c11'));
  assert.equal(packed.status, 0, packed.stderr);
  assert.match(packed.stderr, /^proofs: \S+ \(3 leaves, 2 files, descriptor \d+ bytes\)\nmap: [^\n]+\n$/);
  const verified = run('verify', '--cid', packed.stdout.trim(), '--file', video, '--proofs', join(dir, 'c11'));
  assert.equal(verified.stdout, 'verify OK\n', verified.stderr);
});

test('C-12 pack assets writes the bare manifest block beside the CAR', async () => {
  const assets = join(dir, 'assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'style.json'), '{"version":8}');
  const result = run('assets', assets, '--out', join(dir, 'site.car'));
  assert.equal(result.status, 0, result.stderr);
  const block = await readFile(join(dir, 'site.masl'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
  assert.deepEqual(parseCid(result.stdout.trim(), 'anchor').digest, digest, 'the block is the anchor\'s own bytes');
  assert.ok(existsSync(join(dir, 'site.car')));
});
