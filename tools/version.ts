// Sets the version line: anymirror, @anymirror/fisl-router and veritiles move
// together, and veritiles pins anymirror at the same version.
// @anymirror/router is versioned on its own and changes only with the
// contract, by hand. Run `npm install` after, so the lockfile follows.
//
//   node tools/version.ts X.Y.Z

import { readFile, writeFile } from 'node:fs/promises';

const LINE = ['anymirror', 'fisl-router', 'veritiles'];
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const version = process.argv[2];
if (version === undefined || !VERSION_RE.test(version)) {
  console.error('usage: node tools/version.ts X.Y.Z');
  process.exit(1);
}

for (const dir of LINE) {
  const path = new URL(`../packages/${dir}/package.json`, import.meta.url);
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  const dependencies = pkg.dependencies?.anymirror === undefined ? pkg.dependencies : { ...pkg.dependencies, anymirror: version };
  await writeFile(path, `${JSON.stringify({ ...pkg, version, dependencies }, null, 2)}\n`);
}
console.log(`${LINE.join(', ')} at ${version}: run npm install to update the lockfile`);
