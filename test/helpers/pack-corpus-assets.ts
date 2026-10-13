// `pack assets` cases for the differential corpus: walk order over tricky
// names, extensions and --type, dedup, symlinks, the inline budget edges,
// manifest limits, odd names, and the committed fonts bundle.

import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deterministicBytes } from './bytes.ts';
import type { PackCase } from './pack-corpus.ts';

const BUDGET = 256 * 1024;
const text = (value: string) => new TextEncoder().encode(value);

const assetsCase = (name: string, inputs: Record<string, Uint8Array>, args: string[] = [], setup?: PackCase['setup']): PackCase => ({
  name: `assets ${name}`,
  inputs,
  args: ['assets', 'd', ...args],
  ...(setup === undefined ? {} : { setup }),
});

// Names whose UTF-16, UTF-8, and length orders disagree, plus every
// extension shape.
const TRICKY = [
  'a', 'a.txt', 'a b', 'a.dir/x', 'a0/b', 'b', 'B', '.hidden', 'trailing.', 'UPPER.PNG', 'noext', 'x.tar.GZ',
  'v1.2/LICENSE', 'v1.2/sub.json/data.JSON', '\u{1F600}.json', '\u{E000}', '\u{FFFD}', 'é.webp', 'é.jpeg',
  'z'.repeat(23), 'z'.repeat(24), 'z'.repeat(255), 'Σ.ΣΣ', 'İ.PBF',
];

function trickyInputs(): Record<string, Uint8Array> {
  return Object.fromEntries(TRICKY.map((name, i) => [`d/${name}`, deterministicBytes(10 + i * 37, i + 1)]));
}

function fontsInputs(): Record<string, Uint8Array> {
  const fonts = fileURLToPath(new URL('../../examples/assets/fonts/', import.meta.url));
  const inputs: Record<string, Uint8Array> = {};
  for (const stack of readdirSync(fonts)) {
    for (const file of readdirSync(join(fonts, stack))) inputs[`fonts/${stack}/${file}`] = readFileSync(join(fonts, stack, file));
  }
  return inputs;
}

const sized = (sizes: number[], fill?: number) =>
  Object.fromEntries(sizes.map((size, i) => [`d/f${i}`, fill === undefined ? deterministicBytes(size, i + 3) : new Uint8Array(size).fill(fill)]));

const deep = (depth: number) => `d/${Array.from({ length: depth }, (_, i) => `l${i}`).join('/')}/f.json`;

const links = async (dir: string) => {
  await symlink('a.json', join(dir, 'd/link.json'));
  await symlink('sub', join(dir, 'd/linkdir'));
  await symlink('missing', join(dir, 'd/dangling'));
  await symlink(join(dir, 'd/a.json'), join(dir, 'd/absolute.json'));
};

const badName = async (dir: string) => {
  await mkdir(join(dir, 'd/sub'), { recursive: true });
  await writeFile(Buffer.concat([Buffer.from(join(dir, 'd/sub/bad')), Buffer.from([0xc3, 0x28])]), 'x');
  await writeFile(Buffer.concat([Buffer.from(join(dir, 'd/sub/worse')), Buffer.from([0xff, 0xfe])]), 'y');
};

const empty = (...dirs: string[]) => async (dir: string) => {
  for (const sub of dirs) await mkdir(join(dir, sub), { recursive: true });
};

export function assetsCorpus(): PackCase[] {
  const tricky = trickyInputs();
  return [
    assetsCase('tricky names', tricky),
    assetsCase('tricky names, --type overrides', tricky, ['--type', 'txt=text/plain,.GZ=application/gzip,.=x/none,PBF=x/glyphs,json=x/j']),
    assetsCase('--type: the last flag wins', tricky, ['--type', 'png=bad', '--type', 'png=image/x-png']),
    assetsCase('--type without "=" (error)', tricky, ['--type', 'png']),
    assetsCase('--type with an empty extension (error)', tricky, ['--type', '=x/y']),
    assetsCase('--type with an empty type (error)', tricky, ['--type', 'png=,a=b']),
    assetsCase('--type of 256 bytes (error)', tricky, ['--type', `txt=${'t'.repeat(256)}`]),
    assetsCase('--type of 255 bytes', tricky, ['--type', `txt=${'t'.repeat(255)}`]),
    assetsCase('empty and identical files', { 'd/e1': new Uint8Array(0), 'd/e2': new Uint8Array(0), 'd/x.json': text('{}'), 'd/y.json': text('{}'), 'd/s/x.json': text('{}') }),
    assetsCase('symlinks are skipped', { 'd/a.json': text('{"a":1}'), 'd/sub/b.json': text('{"b":2}') }, [], links),
    assetsCase('unique bytes exactly at the budget', sized([BUDGET - 100, 100])),
    assetsCase('unique bytes one over the budget', sized([BUDGET - 100, 101])),
    assetsCase('duplicates over the budget, unique under', sized([200_000, 200_000, 1], 7)),
    assetsCase('one file over the budget', sized([BUDGET + 1])),
    assetsCase('empty directory (error)', {}, [], empty('d')),
    assetsCase('only empty directories (error)', {}, [], empty('d/a/b', 'd/c')),
    assetsCase('missing directory (error)', {}, []),
    assetsCase('a file, not a directory (error)', { d: text('x') }),
    assetsCase('name that is not UTF-8 (error)', { 'd/a': text('a') }, [], badName),
    assetsCase('32 path segments', { [deep(31)]: text('{}') }),
    assetsCase('33 path segments (error)', { [deep(32)]: text('{}') }),
    assetsCase('manifest over its cap (error)', Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`d/${i}`, text(`${i}`)]))),
    assetsCase('--out into a missing directory (error)', { 'd/a': text('a') }, ['--out', 'missing/b.car']),
    assetsCase('--out elsewhere', { 'd/a': text('a') }, ['--out', 'out/b.car'], empty('out')),
    { name: 'assets examples/assets/fonts → fonts.car', inputs: fontsInputs(), args: ['assets', 'fonts', '--out', 'fonts.car'] },
    { name: 'assets with a trailing slash and dot segments', inputs: { 'd/a': text('a') }, args: ['assets', './x/../d//'] },
  ];
}
