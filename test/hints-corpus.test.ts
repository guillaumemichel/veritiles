// Spec-as-fixtures corpus (PLAN-hints S7): one document per parser-rule family
// under test/fixtures/hints, each swept against a doc URL to an exact expected
// entry map. This documents the SPEC §5 salvage behavior, pins it
// against refactors, and is the seed of a conformance suite for any second
// implementation.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseHintsDocument } from '../src/hints.ts';

const RAW1 = 'bafkreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae';
const CBOR1 = 'bafyreiadambqgaydambqgaydambqgaydambqgaydambqgaydambqgaydam';
const DOC = 'https://host.example/dir/hints.json';

// Each row: the fixture file, the doc URL it parses against, and the exact
// expected entry map — or null for a document that is rejected whole.
const CORPUS: { fixture: string; docUrl: string; expected: Record<string, string[]> | null }[] = [
  { fixture: 'valid-minimal', docUrl: DOC, expected: { [RAW1]: ['https://cdn.example/world.pmtiles'] } },
  {
    fixture: 'valid-multi-cid',
    docUrl: DOC,
    expected: {
      [CBOR1]: ['https://node.example/world.pmtiles.proofs'],
      [RAW1]: ['https://cdn-a.example/world.pmtiles', 'https://cdn-b.example/world.pmtiles'],
    },
  },
  { fixture: 'empty-object', docUrl: DOC, expected: {} },
  { fixture: 'empty-hints', docUrl: DOC, expected: {} },
  { fixture: 'hints-not-object', docUrl: DOC, expected: {} },
  { fixture: 'junk-top-keys', docUrl: DOC, expected: { [RAW1]: ['https://cdn.example/world.pmtiles'] } },
  { fixture: 'bad-cid-keys', docUrl: DOC, expected: { [RAW1]: ['https://good.example/x'] } },
  { fixture: 'mixed-type-urls', docUrl: DOC, expected: { [RAW1]: ['https://keep.example/1', 'https://keep.example/2'] } },
  { fixture: 'bad-schemes', docUrl: DOC, expected: { [RAW1]: ['http://h.example/ok', 'https://h.example/ok2'] } },
  { fixture: 'oversized-url', docUrl: DOC, expected: { [RAW1]: ['https://h/small'] } },
  { fixture: 'duplicate-keys', docUrl: DOC, expected: { [RAW1]: ['https://last.example/x'] } },
  { fixture: 'non-object-array', docUrl: DOC, expected: null },
  { fixture: 'non-object-string', docUrl: DOC, expected: null },
  {
    fixture: 'relative-urls',
    docUrl: DOC,
    expected: { [RAW1]: ['https://host.example/dir/x', 'https://host.example/y', 'https://host.example/dir/sub/z', 'https://other.example/w'] },
  },
  { fixture: 'trailing-slash', docUrl: DOC, expected: { [RAW1]: ['https://h.example/a', 'https://h.example/b'] } },
];

for (const { fixture, docUrl, expected } of CORPUS) {
  test(`HC corpus: ${fixture}`, () => {
    const text = readFileSync(new URL(`./fixtures/hints/${fixture}.json`, import.meta.url), 'utf8');
    const parsed = parseHintsDocument(text, docUrl);
    if (expected === null) {
      assert.equal(parsed, null, `${fixture} should reject the whole document`);
      return;
    }
    assert.ok(parsed instanceof Map, `${fixture} should parse to a map`);
    assert.deepEqual(Object.fromEntries(parsed), expected, fixture);
  });
}
