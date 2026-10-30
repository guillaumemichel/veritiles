// The router in an anymirror reader: a page that knows only the anchor reads a
// file from the hosts a FISL index names, and every byte is verified, so a
// host serving wrong bytes costs a request, never a wrong byte.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from '../packages/core/src/verified-file.ts';

import { packFixed } from '../tools/pack.ts';
import { fisl } from '../packages/fisl-router/src/index.ts';

const INDEX = 'https://index.example';
const GOOD = 'https://good.example/data.bin';
const BAD = 'https://bad.example/data.bin';

const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31 + (i >> 8)) & 0xff);
const packed = await packFixed(data, { chunkSize: 16_384 });

// The index, a host serving the file, and one serving it with a byte
// flipped in every range; every content request is logged.
function world(order: string[]) {
  const requests: string[] = [];
  const records = (path: string) => order.map((host) => JSON.stringify({ addrs: [{ url: `${host}${path}` }] })).join('\n');
  const answers: Record<string, string> = { [packed.anchor]: records('.proofs/root'), [packed.mapCid]: records('') };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const cid = /^https:\/\/index\.example\/routing\/locations\/([^/]+)\/jsonl$/.exec(url)?.[1];
    if (cid !== undefined) return new Response(answers[cid] ?? '');
    requests.push(url);
    const host = [GOOD, BAD].find((h) => url.startsWith(h));
    if (host === undefined) return new Response('nf', { status: 404 });
    return serve(url.slice(host.length), new Headers(init?.headers), host === BAD);
  }) as typeof fetch;
  return { fetchFn, requests };
}

function serve(rest: string, headers: Headers, flip: boolean): Response {
  if (rest.startsWith('.proofs/')) {
    const proof = packed.proofs.get(rest.slice('.proofs/'.length));
    return proof === undefined ? new Response('nf', { status: 404 }) : new Response(new Uint8Array(proof));
  }
  if (rest !== '') return new Response('nf', { status: 404 });
  const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range') ?? '');
  if (range === null) return new Response('ranges only', { status: 200 });
  const body = data.slice(Number(range[1]), Number(range[2]) + 1);
  if (flip) body[0]! ^= 1;
  return new Response(body, { status: 206 });
}

test('E-01 an anchor alone reads through the hosts the index names', async () => {
  const { fetchFn, requests } = world([GOOD]);
  const file = new VerifiedFile({ cid: packed.anchor, router: fisl({ url: INDEX, fetchFn }), fetchFn });
  assert.deepEqual(await file.read(0, data.length), data);
  assert.ok(requests.length > 0 && requests.every((url) => url.startsWith(GOOD)));
  assert.equal(file.stats.rejected, 0);
});

test('E-02 a host serving wrong bytes is passed over for the next one the index names', async () => {
  const { fetchFn, requests } = world([BAD, GOOD]);
  const file = new VerifiedFile({ cid: packed.anchor, router: fisl({ url: INDEX, fetchFn }), fetchFn });
  assert.deepEqual(await file.read(50_000, 1_000), data.subarray(50_000, 51_000));
  assert.ok(file.stats.rejected > 0, 'the flipped range was caught');
  assert.ok(requests.some((url) => url === BAD) && requests.some((url) => url === GOOD));
});
