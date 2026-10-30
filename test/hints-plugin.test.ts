// Hints as a plugin (SPEC §5): a reader fetches no hints document and probes
// no directory unless the page turns hints on with `hints()`. veritiles'
// own classes turn them on by default, configured by document URLs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hints } from '../src/hints.ts';
import { VerifiedFile as HintedFile } from '../src/hinted-file.ts';
import { VerifiedFile } from '../src/verified-file.ts';
import { buildPkgFlat } from './helpers/pkg-fixtures.ts';
import { scene, withPageUrl } from './helpers/serve-hints.ts';

const PAGE = 'https://page.example/index.html';
const P = 'https://node.example/map';
const C = 'https://cdn.example/map';

// A proof node whose directory names the content host, and a page document
// naming it too: everything hints could find.
async function proofOnly() {
  const pkg = await buildPkgFlat();
  const { fetchFn, requests } = scene(
    [{ fileUrl: P, bytes: pkg.mapBytes, proofs: pkg.proofs }, { fileUrl: C, bytes: pkg.mapBytes }],
    { [`${P}.proofs/hints.json`]: { [pkg.mapCid]: [C] }, 'https://page.example/hints.json': { [pkg.mapCid]: [C] } },
  );
  const leaf = pkg.leaves[0]!;
  const expected = pkg.mapBytes.subarray(leaf.offset, leaf.offset + leaf.length);
  return { pkg, fetchFn, requests, leaf, expected };
}

const hintsRequests = (requests: string[]) => requests.filter((url) => url.endsWith('/hints.json'));

test('HP-01: without the plugin, {cid, proof} asks for no hints document and fails naming none', async () => {
  const { pkg, fetchFn, requests } = await proofOnly();
  await withPageUrl(PAGE, async () => {
    const file = new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn });
    await assert.rejects(file.read(0, 100), new RegExp(`^Error: no content location for ${pkg.mapCid}; consulted no hints documents$`));
  });
  assert.deepEqual(hintsRequests(requests), []);
});

test('HP-02: with hints(), the same client consults the page document, probes the proof directory, and reads', async () => {
  const { pkg, fetchFn, requests, leaf, expected } = await proofOnly();
  await withPageUrl(PAGE, async () => {
    const file = new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn, hints: hints() });
    assert.deepEqual(await file.read(leaf.offset, leaf.length), expected);
  });
  assert.deepEqual(hintsRequests(requests), ['https://page.example/hints.json']);
});

test('HP-03: hints(url) names the documents, the page default no longer consulted', async () => {
  const { pkg, fetchFn, requests, leaf, expected } = await proofOnly();
  await withPageUrl(PAGE, async () => {
    const file = new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn, hints: hints(`${P}.proofs/hints.json`) });
    assert.deepEqual(await file.read(leaf.offset, leaf.length), expected);
  });
  assert.deepEqual(hintsRequests(requests), [`${P}.proofs/hints.json`]);
});

test('HP-04: a hints option that is not the plugin is refused at construction', async () => {
  const { pkg } = await proofOnly();
  for (const bad of ['./hints.json', ['./hints.json'], {}]) {
    assert.throws(
      () => new VerifiedFile({ cid: pkg.anchor, proof: `${P}.proofs`, hints: bad as never }),
      /^Error: hints must be the plugin hints\(\) makes$/,
    );
  }
});

test("HP-05: veritiles' VerifiedFile turns hints on by default and takes document URLs", async () => {
  const { pkg, fetchFn, requests, leaf, expected } = await proofOnly();
  await withPageUrl(PAGE, async () => {
    const file = new HintedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn });
    assert.deepEqual(await file.read(leaf.offset, leaf.length), expected);
    const named = new HintedFile({ cid: pkg.anchor, proof: `${P}.proofs`, fetchFn, hints: `${P}.proofs/hints.json` });
    assert.deepEqual(await named.read(leaf.offset, leaf.length), expected);
  });
  assert.deepEqual(hintsRequests(requests), ['https://page.example/hints.json', `${P}.proofs/hints.json`]);
});
