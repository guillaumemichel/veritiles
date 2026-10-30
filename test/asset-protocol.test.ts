import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedAsset } from '../src/asset.ts';
import { NotFoundError } from '../src/bundle.ts';
import { assetProtocol } from '../src/asset-protocol.ts';
import { VerificationError } from '../src/verify.ts';
import { buildArtifact, serveArtifact } from './helpers/artifact.ts';
import { buildRaw, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';

const STYLE_BASE = 'https://h/style';
const FONTS_BASE = 'https://h/fonts';
const GLYPH_PATH = 'Noto Sans Regular/0-255.pbf';
const GLYPH_URL_SEG = 'Noto%20Sans%20Regular/0-255.pbf';

async function setup(hooks?: Parameters<typeof serveArtifact>[0][number]['hooks']) {
  const raw = await buildRaw();
  const tree = await buildTree();
  const server = serveArtifact([
    { base: STYLE_BASE, fixture: raw },
    { base: FONTS_BASE, fixture: tree, hooks },
  ]);
  const style = new VerifiedAsset({ cid: raw.anchor, source: STYLE_BASE, fetchFn: server.fetch });
  const fonts = new VerifiedAsset({ cid: tree.anchor, source: FONTS_BASE, fetchFn: server.fetch });
  return { raw, tree, style, fonts, protocol: assetProtocol([style, fonts]) };
}

test('M-01 requests route to the asset named by the anchor', async () => {
  const { raw, style, fonts, protocol } = await setup();
  const styleRes = await protocol({ url: `verified://${style.cid}` });
  assert.deepEqual(new Uint8Array(styleRes.data), raw.files.get(''));
  const glyphRes = await protocol({ url: `verified://${fonts.cid}/${GLYPH_URL_SEG}` });
  assert.deepEqual(new Uint8Array(glyphRes.data), TREE_ENTRIES[1]!.bytes);
});

test('M-02 path segments are decodeURIComponent-ed before bytes()', async () => {
  const { fonts, protocol } = await setup();
  const res = await protocol({ url: `verified://${fonts.cid}/${GLYPH_URL_SEG}` });
  assert.deepEqual(new Uint8Array(res.data), TREE_ENTRIES[1]!.bytes);
  // Sanity: the decoded path is what the asset resolves.
  assert.deepEqual(await fonts.bytes(GLYPH_PATH), TREE_ENTRIES[1]!.bytes);
});

test('M-03 NotFound on a .pbf path resolves an empty response', async () => {
  const { fonts, protocol } = await setup();
  const res = await protocol({ url: `verified://${fonts.cid}/missing/0-255.pbf` });
  assert.equal(res.data.byteLength, 0);
});

test('M-04 NotFound on a non-.pbf path rethrows', async () => {
  const { fonts, protocol } = await setup();
  await assert.rejects(protocol({ url: `verified://${fonts.cid}/missing.json` }), NotFoundError);
});

test('M-05 a proof verification failure on a .pbf path propagates', async () => {
  const { fonts, protocol } = await setup({ tamper: (u, b) => (u.endsWith('.car') ? new Uint8Array(b.map((x) => x ^ 0xff)) : undefined) });
  await assert.rejects(
    protocol({ url: `verified://${fonts.cid}/${GLYPH_URL_SEG}` }),
    (err: unknown) => err instanceof AggregateError && err.errors.some((e) => e instanceof VerificationError),
  );
});

test('M-06 an unknown anchor or a non-verified URL throws', async () => {
  const { protocol } = await setup();
  await assert.rejects(protocol({ url: 'verified://bafunknownanchor/x' }), /unknown anchor/);
  await assert.rejects(protocol({ url: 'https://h/not-verified' }), /not a verified/);
});

test('M-07 a duplicate anchor throws at construction', async () => {
  const raw = await buildRaw();
  const a = new VerifiedAsset({ cid: raw.anchor, source: STYLE_BASE });
  const b = new VerifiedAsset({ cid: raw.anchor, source: STYLE_BASE });
  assert.throws(() => assetProtocol([a, b]), /duplicate anchor/);
});

test('M-08 the returned buffer is a fresh copy each call', async () => {
  const { raw, style, protocol } = await setup();
  const first = await protocol({ url: `verified://${style.cid}` });
  new Uint8Array(first.data)[0] = 0xff; // mutate the returned buffer
  const second = await protocol({ url: `verified://${style.cid}` });
  assert.deepEqual(new Uint8Array(second.data), raw.files.get(''));
});

test('M-09 aborting during a read rejects the handler', async () => {
  const { style, protocol } = await setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(protocol({ url: `verified://${style.cid}` }, controller));
});

test('M-10 a URL with no path resolves bytes("")', async () => {
  const { raw, style, protocol } = await setup();
  const res = await protocol({ url: `verified://${style.cid}` });
  assert.deepEqual(new Uint8Array(res.data), raw.files.get(''));
});

// MapLibre uses what a handler answers as it is: it asks for a sprite index
// or a style as `json`, and parses nothing itself.
test('M-11 a json request resolves the parsed value, a string request the text', async () => {
  const body = JSON.stringify({ shop: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 } });
  const artifact = await buildArtifact(new TextEncoder().encode(body));
  const server = serveArtifact([{ base: STYLE_BASE, fixture: artifact }]);
  const protocol = assetProtocol([new VerifiedAsset({ cid: artifact.anchor, source: STYLE_BASE, fetchFn: server.fetch })]);
  const url = `verified://${artifact.anchor}`;
  assert.deepEqual((await protocol({ url, type: 'json' })).data, JSON.parse(body));
  assert.equal((await protocol({ url, type: 'string' })).data, body);
});

test('M-12 an arrayBuffer or image request resolves the bytes', async () => {
  const { raw, style, protocol } = await setup();
  for (const type of ['arrayBuffer', 'image'] as const) {
    const res = await protocol({ url: `verified://${style.cid}`, type });
    assert.deepEqual(new Uint8Array(res.data), raw.files.get(''), type);
  }
});

test('M-13 a json request for bytes that are not JSON rejects', async () => {
  const { style, protocol } = await setup();
  await assert.rejects(protocol({ url: `verified://${style.cid}`, type: 'json' }), SyntaxError);
});
