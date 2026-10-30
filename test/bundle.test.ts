// A MASL bundle by its manifest's CID (SPEC §3.2): files by path, each
// verified against the manifest, absence authenticated by it. Hints are off
// unless the page turns them on.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError, VerifiedBundle } from '../packages/core/src/bundle.ts';
import { hints } from '../packages/core/src/hints.ts';
import { VerificationError } from '../packages/core/src/verify.ts';
import { serveArtifact } from './helpers/artifact.ts';
import { buildRaw, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';
import { withPageUrl } from './helpers/serve-hints.ts';

const BASE = 'https://h/a';
const PAGE_DOC = 'https://page.example/hints.json';

test('VB-01: files by path and their stat; a missing path is authenticated absence', async () => {
  const fixture = await buildTree();
  const server = serveArtifact([{ base: BASE, fixture }]);
  const bundle = new VerifiedBundle({ cid: fixture.anchor, source: BASE, fetchFn: server.fetch });
  assert.deepEqual(await bundle.bytes('Noto Sans Regular/0-255.pbf'), TREE_ENTRIES[1]!.bytes);
  assert.deepEqual(await bundle.stat('style.json'), { size: 200, contentType: 'application/json' });
  await assert.rejects(bundle.bytes('missing'), NotFoundError);
  await assert.rejects(bundle.bytes('../x'), VerificationError);
  assert.deepEqual(server.requests, [`${BASE}.car`]);
  assert.equal(bundle.cid, fixture.anchor);
});

test('VB-02: a dag-cbor anchor only', async () => {
  const raw = await buildRaw();
  assert.throws(() => new VerifiedBundle({ cid: raw.anchor, source: BASE }), /^VerificationError: anchor: CID codec must be dag-cbor \(a MASL manifest\)$/);
});

test('VB-03: hints are off unless the page turns them on', async () => {
  const fixture = await buildTree();
  const server = serveArtifact([{ base: BASE, fixture }]);
  const docs: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== PAGE_DOC) return server.fetch(input, init);
    docs.push(PAGE_DOC);
    return new Response(JSON.stringify({ hints: { [fixture.anchor]: [`${BASE}.car`] } }));
  }) as typeof fetch;
  await withPageUrl('https://page.example/index.html', async () => {
    const off = new VerifiedBundle({ cid: fixture.anchor, fetchFn });
    await assert.rejects(off.bytes('style.json'), new RegExp(`^Error: no proof location for ${fixture.anchor}; consulted no hints documents$`));
    assert.deepEqual(docs, []);
    const on = new VerifiedBundle({ cid: fixture.anchor, fetchFn, hints: hints() });
    assert.deepEqual(await on.bytes('style.json'), TREE_ENTRIES[0]!.bytes);
    assert.deepEqual(docs, [PAGE_DOC]);
  });
});
