import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ANSWER_BYTES, readRecords } from '../packages/fisl-router/src/records.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const LATER = '2026-11-01T00:00:00Z';
const EARLIER = '2026-10-01T00:00:00Z';

const answer = (...lines: unknown[]) =>
  new Response(lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));

test("R-01 reads each record's live URLs, in order, and keeps its fields for the layers above", async () => {
  const extended = { addrs: [{ url: 'https://a.example/x' }, { url: 'http://b.example/x' }], expires: LATER, extra: { nested: [1] } };
  const plain = { addrs: [{ url: 'https://f.example/x', expires: LATER }] };
  assert.deepEqual(await readRecords(answer(extended, plain), NOW), [
    { urls: ['https://a.example/x', 'http://b.example/x'], fields: extended },
    { urls: ['https://f.example/x'], fields: plain },
  ]);
});

test('R-02 skips malformed lines, lapsed records and addrs, and URLs that are not absolute http(s)', async () => {
  const ok = 'https://ok.example/x';
  const last = { addrs: [{ url: 'https://lapsed.example/x', expires: EARLIER }, { url: ok, expires: LATER }] };
  const got = await readRecords(
    answer(
      'not json',
      '[1,2]',
      '',
      'null',
      '42',
      { addrs: 'x' },
      { addrs: [] },
      { addrs: [{ url: 'ftp://x.example/x' }, { url: 'relative/x' }, { url: 42 }, 'https://bare.example/x'] },
      { expires: EARLIER, addrs: [{ url: ok }] },
      { expires: 'soon', addrs: [{ url: ok }] },
      { expires: 1, addrs: [{ url: ok }] },
      last,
    ),
    NOW,
  );
  assert.deepEqual(got, [{ urls: [ok], fields: last }]);
});

test('R-03 lines may arrive in pieces, split inside a character; an empty body is no records', async () => {
  const text = `${JSON.stringify({ addrs: [{ url: 'https://é.example/x' }] })}\n${JSON.stringify({ addrs: [{ url: 'https://b.example/y' }] })}\n`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
      controller.close();
    },
  });
  const got = await readRecords(new Response(body), NOW);
  assert.deepEqual(got.map((r) => r.urls[0]), ['https://é.example/x', 'https://b.example/y']);
  assert.deepEqual(await readRecords(new Response(''), NOW), []);
  assert.deepEqual(await readRecords(new Response(null), NOW), []);
});

test('R-04 stops at the byte bound and keeps the whole records it read', async () => {
  const line = `${JSON.stringify({ addrs: [{ url: `https://h.example/${'x'.repeat(200)}` }] })}\n`;
  const count = Math.ceil((MAX_ANSWER_BYTES * 1.5) / line.length);
  const got = await readRecords(new Response(line.repeat(count)), NOW);
  assert.ok(got.length > 0 && got.length < count, `read ${got.length} of ${count}`);
  assert.ok(got.length * line.length <= MAX_ANSWER_BYTES);
  assert.ok(got.every((r) => r.urls.length === 1));
});
