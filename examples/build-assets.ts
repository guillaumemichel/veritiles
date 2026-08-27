// Builds the committed fixture behind examples/assets.html with the shipped
// packer: packs the glyph tree under examples/assets/fonts/ into a MASL
// bundle CAR (SPEC §3.2) via `packAssets`, derives the style raw artifact
// from the resulting anchor, round-trips everything through the real
// VerifiedAsset client, and drift-guards the anchors hardcoded in assets.html.
//
//   node examples/build-assets.ts   (also runs as part of `npm test`)
//
// Rerun after changing anything under examples/assets/fonts/; if the guard
// reports drift, paste the printed anchors into examples/assets.html.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NotFoundError, VerifiedAsset } from '../src/index.ts';
import { packAssets } from '../tools/pack.ts';
import { buildArtifact, serveArtifact, type Artifact } from '../test/helpers/artifact.ts';

// The published demo map the other examples render; the style's vector
// source points at it by anchor. NOTE: predates 0.3.0's proof format —
// replace with the anchor printed by `npm run pack` when the demo map is
// republished.
const MAP_ANCHOR = 'bafyrei…';

const here = fileURLToPath(new URL('.', import.meta.url));
const assetsDir = join(here, 'assets');
const fontsDir = join(assetsDir, 'fonts');
const htmlPath = join(here, 'assets.html');

// ---- fonts: a MASL bundle CAR, packed by the shipped tool -------------------

const packed = await packAssets(fontsDir);
assert.ok(packed.files.size > 0, `no glyph files under ${fontsDir}`);
const fonts: Artifact = { anchor: packed.anchor, rootCid: packed.anchor, files: packed.files, proof: packed.car };
await writeFile(join(assetsDir, 'fonts.car'), packed.car);

// ---- style: a raw artifact whose trust references embed the anchors ---------

const style = {
  version: 8,
  sources: {
    'pmtiles-source': {
      type: 'vector',
      url: `pmtiles://${MAP_ANCHOR}`,
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
      // a range it lacks is an authenticated absence -> empty glyphs (SPEC §3.2).
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
const glyphPath = [...packed.files.keys()][0]!;
const glyph = await fontsAsset.bytes(glyphPath);
assert.equal(Buffer.compare(glyph, packed.files.get(glyphPath)!), 0, 'glyph read must be byte-identical');
await assert.rejects(fontsAsset.bytes('Noto Sans Regular/nope.pbf'), NotFoundError);

// Flipping every response's last byte corrupts the last glyph's inlined
// section in the CAR (the manifest, at the front, still verifies) and every
// content body. The lying section is discarded (SPEC §3.2) and the fallback
// to `{base}/{path}` serves tampered bytes, so the read rejects.
const tampered = serveArtifact([
  {
    base: 'mem://fonts',
    fixture: fonts,
    hooks: {
      tamper: (_url, bytes) => {
        const copy = bytes.slice();
        copy[copy.length - 1]! ^= 0xff;
        return copy;
      },
    },
  },
]);
const lastGlyphPath = [...packed.files.keys()].at(-1)!;
const tamperedAsset = new VerifiedAsset({ cid: fonts.anchor, source: 'mem://fonts', fetchFn: tampered.fetch });
await assert.rejects(tamperedAsset.bytes(lastGlyphPath), AggregateError);
assert.equal(tamperedAsset.stats.rejected, 1, 'a tampered glyph must count one rejection');

// ---- drift guard against assets.html ----------------------------------------

const expected = { STYLE_CID: styleArtifact.anchor, FONTS_ANCHOR: fonts.anchor, MAP_ANCHOR };
console.log('fixture written to examples/assets/:');
console.log(`  style.json  ${styleBytes.length} B   STYLE_CID    ${expected.STYLE_CID}`);
console.log(`  fonts.car   ${packed.car.length} B   FONTS_ANCHOR ${expected.FONTS_ANCHOR}`);
console.log(`  map (remote package)       MAP_ANCHOR   ${expected.MAP_ANCHOR}`);

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
