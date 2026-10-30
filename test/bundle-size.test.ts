// Bundle budgets: what a page pays for each use, its entry bundled as an
// app's bundler would (esbuild, ESM, minified), then gzipped. Each use also
// names modules it must not carry, code its page never runs: `without` holds
// today, `pending` waits for a cut not made yet and runs as a todo until
// then. A cut moves its modules from `pending` to `without` and lowers the
// budgets it shrinks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

const SPLIT = 'raw files and bundles become two classes';
const RANGED = [
  'src/descriptor.ts',
  'src/proof-format.ts',
  'src/proof-index.ts',
  'src/ranged-reader.ts',
  'src/ranged-store.ts',
  'src/range-source.ts',
  'src/early-source.ts',
];

interface Use {
  name: string;
  entry: string;
  /** Gzipped bytes: the size when last cut, plus a little headroom. */
  budget: number;
  without: string[];
  pending: Record<string, string>;
}

const USES: Use[] = [
  {
    name: 'raw file',
    entry: "export { VerifiedAsset } from './src/asset.ts';",
    budget: 7_950,
    without: RANGED,
    pending: {
      'src/hints.ts': SPLIT,
      'src/manifest.ts': SPLIT,
      'src/car.ts': SPLIT,
      'src/drisl.ts': SPLIT,
      'src/proof-source.ts': SPLIT,
    },
  },
  {
    name: 'MASL bundle',
    entry: "export { VerifiedAsset } from './src/asset.ts';",
    budget: 7_950,
    without: RANGED,
    pending: { 'src/hints.ts': SPLIT },
  },
  {
    name: 'ranged file',
    entry: "export { VerifiedFile } from './src/verified-file.ts';",
    budget: 8_600,
    without: ['src/hints.ts', 'src/manifest.ts', 'src/car.ts', 'src/proof-source.ts'],
    pending: {},
  },
  {
    name: 'map',
    entry: "export { VerifiedSource, VerifiedAsset, assetProtocol } from './src/index.ts';",
    budget: 12_100,
    without: [],
    pending: {},
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
  });
  const code = result.outputFiles[0]!.contents;
  const [output] = Object.values(result.metafile.outputs);
  const modules = Object.entries(output!.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([path]) => path);
  return { minified: code.length, gzipped: gzipSync(code, { level: 9 }).length, modules };
}

for (const { name, entry, budget, without, pending } of USES) {
  test(`${name}: at most ${budget} bytes gzipped`, async () => {
    const { minified, gzipped } = await bundle(entry);
    assert.ok(gzipped <= budget, `${name}: ${gzipped} bytes gzipped (${minified} minified), over its budget of ${budget}`);
  });

  const checks: [string, string | undefined][] = [
    ...without.map((module): [string, undefined] => [module, undefined]),
    ...Object.entries(pending),
  ];
  for (const [module, todo] of checks) {
    test(`${name}: carries no ${module}`, { todo }, async () => {
      const { modules } = await bundle(entry);
      assert.ok(!modules.includes(module), `${name} carries ${module}`);
    });
  }
}

// A router needs the contract alone, so a router's package must cost a
// page nothing beyond its own code.
test('router contract: no runtime code', async () => {
  const { minified, modules } = await bundle("export * from './src/router.ts';");
  assert.deepEqual(modules, []);
  assert.equal(minified, 0);
});

// The checks above only mean something if the bundles hold the modules
// they are made of.
test('map: carries the modules every use needs', async () => {
  const { modules } = await bundle(USES.at(-1)!.entry);
  for (const module of ['src/verified-store.ts', 'src/locations.ts', 'src/hints.ts', 'src/manifest.ts', 'src/ranged-reader.ts']) {
    assert.ok(modules.includes(module), `map lacks ${module}`);
  }
});
