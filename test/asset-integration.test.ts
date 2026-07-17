import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assetProtocol } from '../src/asset-protocol.ts';
import { VerifiedAsset } from '../src/asset.ts';
import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';

const STYLE_BASE = 'https://h/style.json';
const FONTS_BASE = 'https://h/fonts';
const GLYPH_PATH = 'Noto Sans Regular/0-255.pbf';

test('I-01 end-to-end: a verified style yields a verified glyph in three requests', async () => {
  const tree = await buildTree();
  const styleJson = { glyphs: `verified://${tree.anchor}/{fontstack}/{range}.pbf` };
  const style = await buildArtifact(new TextEncoder().encode(JSON.stringify(styleJson)));

  const server = serveArtifact([
    { base: STYLE_BASE, fixture: style },
    { base: FONTS_BASE, fixture: tree },
  ]);
  const styleAsset = new VerifiedAsset({ cid: style.anchor, source: STYLE_BASE, fetchFn: server.fetch });
  const fonts = new VerifiedAsset({ cid: tree.anchor, source: FONTS_BASE, fetchFn: server.fetch });
  const protocol = assetProtocol([fonts]);

  const parsed = JSON.parse(new TextDecoder().decode(await styleAsset.bytes('')));
  const glyphUrl = parsed.glyphs
    .replace('{fontstack}', encodeURIComponent('Noto Sans Regular'))
    .replace('{range}', encodeURIComponent('0-255'));
  const res = await protocol({ url: glyphUrl });

  assert.deepEqual(new Uint8Array(res.data), TREE_ENTRIES[1]!.bytes);
  assert.deepEqual(server.requests, [STYLE_BASE, `${FONTS_BASE}.car`, `${FONTS_BASE}/Noto%20Sans%20Regular/0-255.pbf`]);
});

test('I-02 content tamper sweep: every flipped glyph byte fails over to the clean source', async () => {
  const tree = await buildTree();
  const glyph = TREE_ENTRIES[1]!.bytes;
  for (let pos = 0; pos < glyph.length; pos += 64) {
    const server = serveArtifact([
      { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : flipAt(b, pos)) } },
      { base: 'https://h/B', fixture: tree },
    ]);
    const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
    assert.deepEqual(await asset.bytes(GLYPH_PATH), glyph, `flip at ${pos}`);
    assert.equal(asset.stats.rejected, 1);
  }
});

test('I-03 proof tamper sweep: the whole-body hash catches every flipped proof byte', async () => {
  const tree = await buildTree();
  for (let pos = 0; pos < tree.proof!.length; pos += 64) {
    const server = serveArtifact([
      { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? flipAt(b, pos) : undefined) } },
      { base: 'https://h/B', fixture: tree },
    ]);
    const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
    assert.deepEqual(await asset.bytes(GLYPH_PATH), TREE_ENTRIES[1]!.bytes, `proof flip at ${pos}`);
    assert.equal(asset.stats.rejected, 1);
  }
});

function flipAt(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index % copy.length]! ^= 0xff;
  return copy;
}
