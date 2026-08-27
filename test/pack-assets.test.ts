import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { VerifiedAsset } from '../src/asset.ts';
import { packAssets } from '../tools/pack.ts';

const directory = '/tmp/opencode/veritiles-pack-assets';

test('packAssets emits a MASL CAR that VerifiedAsset reads without content requests', async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(`${directory}/fonts`, { recursive: true });
  await writeFile(`${directory}/style.json`, '{"version":8}');
  await writeFile(`${directory}/fonts/a.pbf`, Uint8Array.of(1, 2, 3));
  const packed = await packAssets(directory);
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url === 'https://h/assets.car') return new Response(new Uint8Array(packed.car));
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  const asset = new VerifiedAsset({ cid: packed.anchor, source: 'https://h/assets', fetchFn });
  assert.deepEqual(await asset.bytes('fonts/a.pbf'), Uint8Array.of(1, 2, 3));
  assert.deepEqual(await asset.stat('style.json'), { size: 13, contentType: 'application/json' });
  assert.deepEqual(requests, ['https://h/assets.car']);
});

test('packAssets emits a manifest-only CAR when the directory exceeds the inline budget', async () => {
  await rm(directory, { recursive: true, force: true });
  await mkdir(`${directory}/fonts`, { recursive: true });
  const glyphs = new Map<string, Uint8Array>();
  for (let i = 0; i < 4; i++) glyphs.set(`fonts/${i}.pbf`, new Uint8Array(100_000).fill(i + 1));
  for (const [path, bytes] of glyphs) await writeFile(`${directory}/${path}`, bytes);
  const packed = await packAssets(directory);
  assert.ok(
    packed.car.length < packed.manifest.length + 512,
    `proof must stay near manifest size: car ${packed.car.length} B, manifest ${packed.manifest.length} B`,
  );
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url === 'https://h/assets.car') return new Response(new Uint8Array(packed.car));
    const bytes = url.startsWith('https://h/assets/') ? glyphs.get(url.slice('https://h/assets/'.length)) : undefined;
    if (bytes) return new Response(new Uint8Array(bytes));
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  const asset = new VerifiedAsset({ cid: packed.anchor, source: 'https://h/assets', fetchFn });
  assert.deepEqual(await asset.bytes('fonts/2.pbf'), glyphs.get('fonts/2.pbf'));
  assert.ok(requests.includes('https://h/assets/fonts/2.pbf'), 'content must be fetched from {base}/{path}');
});
