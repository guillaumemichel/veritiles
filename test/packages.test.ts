// The packages as npm ships them: each built package packed, the tarballs
// installed into an empty project, and imported there without the source
// condition, the way an app sees them. Checks the files each tarball carries,
// what each entry point exports, that the types resolve, and the version
// line. Needs a build first: `npm run build && npm run test:packages`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACES = ['@anymirror/router', 'anymirror', '@anymirror/fisl-router', 'veritiles'];

// The files beyond src/ and dist/ each tarball must carry, and the built
// files its exports name.
const FILES: Record<string, string[]> = {
  '@anymirror/router': ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts'],
  anymirror: [
    'README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts',
    ...['file', 'raw', 'bundle', 'hints'].flatMap((entry) => [`dist/entries/${entry}.js`, `dist/entries/${entry}.d.ts`]),
  ],
  '@anymirror/fisl-router': ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts'],
  veritiles: ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/veritiles.js'],
};

// Every entry point, with the values it exports at run time.
const EXPORTS: Record<string, string[]> = {
  anymirror: ['NotFoundError', 'RangeBlockedError', 'RangeUnsupportedError', 'VerificationError', 'VerifiedBundle', 'VerifiedFile', 'VerifiedRaw', 'assetKind', 'hints'],
  'anymirror/file': ['RangeBlockedError', 'RangeUnsupportedError', 'VerificationError', 'VerifiedFile'],
  'anymirror/raw': ['VerificationError', 'VerifiedRaw'],
  'anymirror/bundle': ['NotFoundError', 'VerificationError', 'VerifiedBundle'],
  'anymirror/hints': ['hints'],
  '@anymirror/router': [],
  '@anymirror/fisl-router': ['fisl', 'interleave', 'readRecords'],
  veritiles: ['NotFoundError', 'RangeBlockedError', 'RangeUnsupportedError', 'VerificationError', 'VerifiedAsset', 'VerifiedFile', 'VerifiedSource', 'assetProtocol'],
};

// An app that names a type from every entry point.
const APP_TYPES = `
import { VerifiedFile, type VerifiedFileOptions } from 'anymirror/file';
import { VerifiedRaw, type VerifiedRawOptions } from 'anymirror/raw';
import { VerifiedBundle, type AssetStat } from 'anymirror/bundle';
import { hints, type Hints } from 'anymirror/hints';
import { assetKind, type VerifyStats } from 'anymirror';
import type { Router, RouterOption } from '@anymirror/router';
import { fisl, type FislRecord } from '@anymirror/fisl-router';
import { VerifiedSource, VerifiedAsset, assetProtocol, type Router as MapRouter } from 'veritiles';

const router: Router = { locate: (cid) => [\`https://mirror.example/\${cid}\`] };
const option: RouterOption = router;
const indexed: Router = fisl({ url: 'https://index.example', select: (records: FislRecord[]) => records.flatMap((record) => record.urls) });
const sameContract: MapRouter = router;
const plugin: Hints = hints();
const file: VerifiedFileOptions = { cid: 'bafy', source: 'https://mirror.example/map.pmtiles', hints: plugin, router: option };
const raw: VerifiedRawOptions = { cid: 'bafk', source: 'https://mirror.example/' };
new VerifiedFile(file);
new VerifiedRaw({ ...raw, router: indexed });
new VerifiedBundle({ cid: 'bafy', source: 'https://mirror.example/' });
new VerifiedSource({ cid: 'bafy', source: 'https://mirror.example/map.pmtiles', hints: './hints.json' });
assetProtocol([new VerifiedAsset({ cid: 'bafk' })]);
export type Checked = [AssetStat, VerifyStats, typeof sameContract, ReturnType<typeof assetKind>];
`;

interface Packed {
  name: string;
  version: string;
  filename: string;
  files: { path: string }[];
}

let app: string;
let packed: Packed[];

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

before(async () => {
  app = await mkdtemp(join(tmpdir(), 'anymirror-packages-'));
  const workspaces = WORKSPACES.flatMap((name) => ['-w', name]);
  // --ignore-scripts: pack the build as it is, without prepack building again.
  packed = JSON.parse(run('npm', ['pack', ...workspaces, '--ignore-scripts', '--json', '--pack-destination', app], root));
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', ...packed.map((pkg) => join(app, pkg.filename))], app);
});

after(async () => {
  await rm(app, { recursive: true, force: true });
});

test('each tarball carries its README, LICENSE and built files', () => {
  for (const pkg of packed) {
    const files = new Set(pkg.files.map((file) => file.path));
    for (const file of FILES[pkg.name]!) assert.ok(files.has(file), `${pkg.name} lacks ${file}`);
  }
});

test('each entry point exports its API', () => {
  const script = `
    const names = {};
    for (const spec of ${JSON.stringify(Object.keys(EXPORTS))}) names[spec] = Object.keys(await import(spec)).sort();
    const [core, map] = [await import('anymirror'), await import('veritiles')];
    console.log(JSON.stringify({ names, shared: core.VerificationError === map.VerificationError }));
  `;
  const { names, shared } = JSON.parse(run('node', ['--input-type=module', '-e', script], app));
  assert.deepEqual(names, Object.fromEntries(Object.entries(EXPORTS).map(([spec, list]) => [spec, [...list].sort()])));
  assert.ok(shared, 'veritiles re-exports anymirror’s classes, not copies');
});

test('the script-tag bundle defines veritiles with the same API', async () => {
  const code = await readFile(join(app, 'node_modules/veritiles/dist/veritiles.js'), 'utf8');
  const context = createContext({ TextEncoder, TextDecoder }); // what a page offers it
  runInContext(code, context);
  assert.deepEqual(Object.keys(context.veritiles).sort(), [...EXPORTS.veritiles!].sort());
});

test('the types resolve as an app sees them', async () => {
  await writeFile(join(app, 'app.ts'), APP_TYPES);
  const compilerOptions = { strict: true, noEmit: true, target: 'es2022', lib: ['es2022', 'dom'], module: 'nodenext', types: [] };
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['app.ts'] }));
  run(join(root, 'node_modules/.bin/tsc'), ['-p', app], app);
});

test('the version line: one version, veritiles pinning anymirror, the FISL router on the contract alone', async () => {
  const manifest = async (name: string) => JSON.parse(await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8'));
  const [anymirror, fislRouter, veritiles] = [await manifest('anymirror'), await manifest('@anymirror/fisl-router'), await manifest('veritiles')];
  assert.equal(fislRouter.version, anymirror.version);
  assert.equal(veritiles.version, anymirror.version);
  assert.equal(veritiles.dependencies.anymirror, anymirror.version);
  assert.deepEqual(Object.keys(fislRouter.dependencies), ['@anymirror/router']);
});
