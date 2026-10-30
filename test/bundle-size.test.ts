// Bundle budgets: what a page pays for each use, its package entry point
// bundled as an app's bundler would (esbuild, ESM, minified), then gzipped.
// Each use also names modules it must not carry, code its page never runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

// A module of @anymirror/core, as the bundle's metafile names it.
const core = (...names: string[]) => names.map((name) => `packages/core/src/${name}.ts`);

const RANGED = core('descriptor', 'proof-format', 'proof-index', 'ranged-reader', 'ranged-store', 'range-source', 'early-source');

interface Use {
  name: string;
  entry: string;
  /** Gzipped bytes: the size when last cut, plus a little headroom. */
  budget: number;
  without: string[];
}

const USES: Use[] = [
  {
    name: 'raw file',
    entry: "export { VerifiedRaw } from '@anymirror/core/raw';",
    budget: 4_450,
    without: [...RANGED, ...core('hints', 'manifest', 'car', 'drisl', 'proof-source')],
  },
  {
    name: 'MASL bundle',
    entry: "export { VerifiedBundle } from '@anymirror/core/bundle';",
    budget: 6_900,
    without: [...RANGED, ...core('hints')],
  },
  {
    name: 'ranged file',
    entry: "export { VerifiedFile } from '@anymirror/core/file';",
    budget: 8_600,
    without: core('hints', 'manifest', 'car', 'proof-source'),
  },
  {
    name: 'map',
    entry: "export { VerifiedSource, VerifiedAsset, assetProtocol } from 'veritiles';",
    budget: 12_400,
    without: [],
  },
];

interface Bundle {
  minified: number;
  gzipped: number;
  modules: string[];
}

const bundles = new Map<string, Promise<Bundle>>();

function bundle(entry: string): Promise<Bundle> {
  let bundled = bundles.get(entry);
  if (bundled === undefined) {
    bundled = bundleOnce(entry);
    bundles.set(entry, bundled);
  }
  return bundled;
}

async function bundleOnce(entry: string): Promise<Bundle> {
  const result = await build({
    stdin: { contents: entry, resolveDir: root },
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    write: false,
    metafile: true,
    conditions: ['anymirror-source'],
  });
  const code = result.outputFiles[0]!.contents;
  const [output] = Object.values(result.metafile.outputs);
  const modules = Object.entries(output!.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([path]) => path);
  return { minified: code.length, gzipped: gzipSync(code, { level: 9 }).length, modules };
}

for (const { name, entry, budget, without } of USES) {
  test(`${name}: at most ${budget} bytes gzipped`, async () => {
    const { minified, gzipped } = await bundle(entry);
    assert.ok(gzipped <= budget, `${name}: ${gzipped} bytes gzipped (${minified} minified), over its budget of ${budget}`);
  });

  for (const module of without) {
    test(`${name}: carries no ${module}`, async () => {
      const { modules } = await bundle(entry);
      assert.ok(!modules.includes(module), `${name} carries ${module}`);
    });
  }
}

// A router needs the contract alone, so a router's package must cost a
// page nothing beyond its own code.
test('router contract: no runtime code', async () => {
  const { minified, modules } = await bundle("export * from '@anymirror/router';");
  assert.deepEqual(modules, []);
  assert.equal(minified, 0);
});

test('FISL router: its own code alone', async () => {
  const { modules } = await bundle("export { fisl } from '@anymirror/fisl-router';");
  assert.ok(modules.length > 0, 'the router has code');
  for (const module of modules) assert.ok(module.startsWith('packages/fisl-router/src/'), `the FISL router carries ${module}`);
});

// The checks above only mean something if the bundles hold the modules
// they are made of.
test('map: carries the modules every use needs', async () => {
  const { modules } = await bundle(USES.at(-1)!.entry);
  for (const module of core('verified-store', 'locations', 'hints', 'manifest', 'ranged-reader')) {
    assert.ok(modules.includes(module), `map lacks ${module}`);
  }
});
