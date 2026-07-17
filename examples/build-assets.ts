// Builds the committed fixture behind examples/assets.html: imports the glyph
// tree under examples/assets/fonts/ as a UnixFS DAG artifact (SPEC.md A9
// profile), emits its proof CAR, derives the style raw artifact from the
// resulting anchor, round-trips everything through the real VerifiedAsset
// client, and drift-guards the anchors hardcoded in assets.html.
//
//   node examples/build-assets.ts
//
// Rerun after changing anything under examples/assets/fonts/; if the guard
// reports drift, paste the printed anchors into examples/assets.html.

import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NotFoundError, VerifiedAsset } from '../src/index.ts';
import { buildArtifact, serveArtifact, type TreeEntry } from '../test/helpers/artifact.ts';

// The published demo map package the other examples already render; the
// style's vector source points at it by CID.
const MAP_ROOT = 'bafybeihnila5l5dabqrbpvaictnce5wop364y5kbc7kfowbnd5mbnpayci';

const here = fileURLToPath(new URL('.', import.meta.url));
const assetsDir = join(here, 'assets');
const fontsDir = join(assetsDir, 'fonts');
const htmlPath = join(here, 'assets.html');

// ---- fonts: a DAG artifact (directory tree) with a proof CAR ----------------

const entries = await collectTree(fontsDir);
assert.ok(entries.length > 0, `no glyph files under ${fontsDir}`);
const fonts = await buildArtifact(entries);
assert.ok(fonts.proof, 'fonts artifact must be a DAG artifact with a proof');
await writeFile(join(assetsDir, 'fonts.car'), fonts.proof);

// ---- style: a raw artifact whose trust references embed the anchors ---------

const style = {
  version: 8,
  sources: {
    'pmtiles-source': {
      type: 'vector',
      url: `pmtiles://${MAP_ROOT}`,
      attribution:
        '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  glyphs: `verified://${fonts.anchor}/{fontstack}/{range}.pbf`,
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f0f8ff' } },
    {
      id: 'land',
      type: 'fill',
      source: 'pmtiles-source',
      'source-layer': 'land',
      paint: { 'fill-color': '#f8f4f0' },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'pmtiles-source',
      'source-layer': 'water',
      paint: { 'fill-color': '#a0c8f0' },
    },
    {
      id: 'places',
      type: 'symbol',
      source: 'pmtiles-source',
      'source-layer': 'places',
      // Prefer the latin name: the example ships only glyph ranges 0-511, and
      // a range it lacks is an authenticated absence -> empty glyphs (A10).
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-size': 12,
        'text-font': ['Noto Sans Regular'],
      },
      paint: {
        'text-color': '#333333',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1,
      },
    },
  ],
};
const styleBytes = new TextEncoder().encode(JSON.stringify(style, null, 2) + '\n');
const styleArtifact = await buildArtifact(styleBytes);
assert.equal(styleArtifact.proof, undefined, 'style must stay a raw artifact (≤ 256 KiB)');
await writeFile(join(assetsDir, 'style.json'), styleBytes);

// ---- round trip through the real client -------------------------------------

const server = serveArtifact([
  { base: 'mem://style.json', fixture: styleArtifact },
  { base: 'mem://fonts', fixture: fonts },
]);
const styleAsset = new VerifiedAsset({
  cid: styleArtifact.anchor,
  source: 'mem://style.json',
  fetchFn: server.fetch,
});
const parsed = JSON.parse(new TextDecoder().decode(await styleAsset.bytes()));
assert.ok(String(parsed.glyphs).includes(fonts.anchor), 'style must reference the fonts anchor');

const fontsAsset = new VerifiedAsset({ cid: fonts.anchor, source: 'mem://fonts', fetchFn: server.fetch });
const glyphPath = entries[0]!.path;
const glyph = await fontsAsset.bytes(glyphPath);
assert.equal(Buffer.compare(glyph, entries[0]!.bytes), 0, 'glyph read must be byte-identical');
await assert.rejects(fontsAsset.bytes('Noto Sans Regular/nope.pbf'), NotFoundError);

const tampered = serveArtifact([
  {
    base: 'mem://fonts',
    fixture: fonts,
    hooks: {
      tamper: (url, bytes) => {
        if (!url.endsWith('.pbf')) return undefined;
        const copy = bytes.slice();
        copy[0]! ^= 0xff;
        return copy;
      },
    },
  },
]);
const tamperedAsset = new VerifiedAsset({ cid: fonts.anchor, source: 'mem://fonts', fetchFn: tampered.fetch });
await assert.rejects(tamperedAsset.bytes(glyphPath), AggregateError);
assert.equal(tamperedAsset.stats.rejected, 1, 'a tampered glyph must count one rejection');

// ---- drift guard against assets.html ----------------------------------------

const expected = { STYLE_CID: styleArtifact.anchor, FONTS_ANCHOR: fonts.anchor, MAP_ROOT };
console.log('fixture written to examples/assets/:');
console.log(`  style.json  ${styleBytes.length} B   STYLE_CID    ${expected.STYLE_CID}`);
console.log(`  fonts.car   ${fonts.proof.length} B   FONTS_ANCHOR ${expected.FONTS_ANCHOR}`);
console.log(`  map (remote package)       MAP_ROOT     ${expected.MAP_ROOT}`);

const html = await readFile(htmlPath, 'utf8').catch(() => undefined);
if (html === undefined) {
  console.log('examples/assets.html not found — create it with the anchors above.');
} else {
  const missing = Object.entries(expected).filter(([, value]) => !html.includes(value));
  if (missing.length > 0) {
    console.error(`assets.html drifted; update: ${missing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
  console.log('assets.html anchors match — fixture and page are in sync.');
}

async function collectTree(dir: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.push({ path: relative(dir, full), bytes: await readFile(full) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
