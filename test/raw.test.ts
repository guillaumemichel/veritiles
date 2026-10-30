// A raw file by its raw CID (SPEC §3.1): read whole at its locations,
// hashed against the anchor, a host with wrong bytes passed over. Hints are
// off unless the page turns them on.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hints } from '../packages/anymirror/src/hints.ts';
import { VerifiedRaw } from '../packages/anymirror/src/raw.ts';
import { serveArtifact } from './helpers/artifact.ts';
import { flipByte } from './helpers/bytes.ts';
import { buildRaw, buildTree } from './helpers/fixtures.ts';
import { withPageUrl } from './helpers/serve-hints.ts';

const BASE = 'https://h/a';
const MIRROR = 'https://m/a';
const PAGE_DOC = 'https://page.example/hints.json';

test('VR-01: a raw file reads its source once, a fresh copy each read', async () => {
  const fixture = await buildRaw();
  const server = serveArtifact([{ base: BASE, fixture }]);
  const raw = new VerifiedRaw({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  const first = await raw.bytes();
  assert.deepEqual(first, fixture.files.get(''));
  first.fill(0);
  assert.deepEqual(await raw.bytes(), fixture.files.get(''));
  assert.deepEqual(server.requests, [BASE]);
  assert.equal(raw.cid, fixture.anchor);
  assert.deepEqual(raw.stats, { verified: 1, rejected: 0 });
});

test('VR-02: wrong bytes are rejected and the next source serves', async () => {
  const fixture = await buildRaw();
  const server = serveArtifact([
    { base: BASE, fixture, hooks: { tamper: (_url, bytes) => flipByte(bytes) } },
    { base: MIRROR, fixture },
  ]);
  const raw = new VerifiedRaw({ cid: fixture.anchor, source: [BASE, MIRROR], fetchFn: server.fetch });
  assert.deepEqual(await raw.bytes(), fixture.files.get(''));
  assert.deepEqual(raw.stats, { verified: 1, rejected: 1 });
});

test('VR-03: a raw anchor only, and sources must be URLs', async () => {
  const tree = await buildTree();
  assert.throws(() => new VerifiedRaw({ cid: tree.anchor, source: BASE }), /^VerificationError: anchor: CID codec must be raw \(one file\)$/);
  const fixture = await buildRaw();
  assert.throws(() => new VerifiedRaw({ cid: fixture.anchor, source: [] }), /^Error: source must be a URL or a non-empty list of URLs$/);
});

test('VR-04: hints are off unless the page turns them on', async () => {
  const fixture = await buildRaw();
  const server = serveArtifact([{ base: BASE, fixture }]);
  const docs: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== PAGE_DOC) return server.fetch(input, init);
    docs.push(PAGE_DOC);
    return new Response(JSON.stringify({ hints: { [fixture.anchor]: [BASE] } }));
  }) as typeof fetch;
  await withPageUrl('https://page.example/index.html', async () => {
    const off = new VerifiedRaw({ cid: fixture.anchor, fetchFn });
    await assert.rejects(off.bytes(), new RegExp(`^Error: no content location for ${fixture.anchor}; consulted no hints documents$`));
    assert.deepEqual(docs, []);
    const on = new VerifiedRaw({ cid: fixture.anchor, fetchFn, hints: hints() });
    assert.deepEqual(await on.bytes(), fixture.files.get(''));
    assert.deepEqual(docs, [PAGE_DOC]);
  });
});
