import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CarReader } from '@ipld/car';

import { VerifiedAsset } from '../src/asset.ts';
import { packAssets } from '../tools/pack.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'veritiles-pack-assets-'));
  dirs.push(dir);
  return dir;
}

test('packAssets emits a MASL CAR that VerifiedAsset reads without content requests', async () => {
  const directory = await freshDir();
  await mkdir(`${directory}/fonts`);
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
  const directory = await freshDir();
  await mkdir(`${directory}/fonts`);
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

async function carCids(car: Uint8Array): Promise<string[]> {
  const cids: string[] = [];
  for await (const block of (await CarReader.fromBytes(car)).blocks()) cids.push(block.cid.toString());
  return cids;
}

test('packAssets writes identical files once and the client reads both', async () => {
  const dir = await freshDir();
  await writeFile(`${dir}/a.json`, '{"same":true}');
  await writeFile(`${dir}/b.json`, '{"same":true}');
  const packed = await packAssets(dir);
  const cids = await carCids(packed.car);
  assert.equal(cids.length, 2, 'manifest + one shared raw block');
  assert.equal(new Set(cids).size, cids.length);
  const fetchFn = (async () => new Response(new Uint8Array(packed.car))) as typeof fetch;
  const asset = new VerifiedAsset({ cid: packed.anchor, source: 'https://h/assets', fetchFn });
  assert.deepEqual(await asset.bytes('b.json'), new TextEncoder().encode('{"same":true}'));
  assert.deepEqual(await asset.bytes('a.json'), new TextEncoder().encode('{"same":true}'));
});

test('packAssets counts unique blocks against the inline budget', async () => {
  const dir = await freshDir();
  const glyph = new Uint8Array(200_000).fill(7);
  await writeFile(`${dir}/0.pbf`, glyph);
  await writeFile(`${dir}/1.pbf`, glyph);
  const packed = await packAssets(dir);
  assert.equal((await carCids(packed.car)).length, 2, '400 KB of files but 200 KB unique: inlined');
});

test('packAssets takes the extension from the file name, not the directory', async () => {
  const dir = await freshDir();
  await mkdir(`${dir}/dir.json`);
  await writeFile(`${dir}/dir.json/LICENSE`, 'MIT');
  await writeFile(`${dir}/dir.json/x.JSON`, '{}');
  // A whole-path extension would be 'json/license'.
  const packed = await packAssets(dir, { types: new Map([['json/license', 'text/plain']]) });
  const fetchFn = (async () => new Response(new Uint8Array(packed.car))) as typeof fetch;
  const asset = new VerifiedAsset({ cid: packed.anchor, source: 'https://h/assets', fetchFn });
  assert.deepEqual(await asset.stat('dir.json/LICENSE'), { size: 3 });
  assert.deepEqual(await asset.stat('dir.json/x.JSON'), { size: 2, contentType: 'application/json' });
});

test('packAssets rejects a file name that is not valid UTF-8', async () => {
  const dir = await freshDir();
  await mkdir(`${dir}/sub`);
  await writeFile(Buffer.concat([Buffer.from(`${dir}/sub/bad`), Buffer.from([0xff])]), 'x');
  await assert.rejects(packAssets(dir), /^Error: asset name is not valid UTF-8: sub\/bad\uFFFD$/);
});
