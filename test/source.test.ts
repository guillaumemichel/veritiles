import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedSource } from '../src/index.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { rangeFetch, type HostOptions } from './helpers/host.ts';
import { buildMapPackage } from './helpers/package.ts';

const mapBytes = deterministicBytes(4000, 30);
const fixture = await buildMapPackage({ mapBytes, cuts: [1000, 2000, 1000] });

function openSource(opts: HostOptions & { files?: Map<string, Uint8Array>; source?: string | string[] } = {}) {
  return new VerifiedSource({
    rootCid: fixture.rootCid,
    source: opts.source ?? 'https://host.example',
    fetchFn: rangeFetch(opts.files ?? fixture.files, opts),
  });
}

test('construction is synchronous and validates the trust anchor', () => {
  assert.throws(() => new VerifiedSource({ rootCid: 'nope', source: 'x' }), /base32/);
  assert.throws(
    () => new VerifiedSource({ rootCid: fixture.rootCid, source: [] }),
    /source must be/,
  );
  // A raw-leaf CID cannot anchor a directory reconstruction.
  assert.throws(
    () =>
      new VerifiedSource({
        rootCid: 'bafkreif7gwevlbmz4rxni3ana5artpb7rjfxk2n5ay76ctzoxwlfmno6ky',
        source: 'x',
      }),
    /must be dag-pb/,
  );
});

test('getKey is the root CID — the pmtiles:// style key', () => {
  assert.equal(openSource().getKey(), fixture.rootCid);
});

test('requests resolve against the base URL verbatim, trailing slashes trimmed', async () => {
  // The package lives under an arbitrary deep path — no /ipfs/<cid>/ layout.
  const deepFiles = new Map([...fixture.files].map(([k, v]) => [`deep/path/${k}`, v] as const));
  const urls: string[] = [];
  const source = openSource({
    files: deepFiles,
    source: 'https://mirror.example/deep/path///',
    onRequest: (url) => urls.push(url),
  });
  await source.ready();
  assert.equal(urls[0], 'https://mirror.example/deep/path/metadata.json');
  const { data } = await source.getBytes(0, 100);
  assert.deepEqual(new Uint8Array(data), mapBytes.subarray(0, 100));
});

test('an IPFS gateway path is just another conforming base URL', async () => {
  const urls: string[] = [];
  const source = openSource({
    source: `https://gateway.example/ipfs/${fixture.rootCid}`,
    onRequest: (url) => urls.push(url),
  });
  const { data } = await source.getBytes(0, 100);
  assert.deepEqual(new Uint8Array(data), mapBytes.subarray(0, 100));
  assert.equal(urls[0], `https://gateway.example/ipfs/${fixture.rootCid}/metadata.json`);
});

test('construction fetches nothing; the first read bootstraps', async () => {
  let requests = 0;
  const source = openSource({ onRequest: () => requests++ });
  assert.equal(requests, 0);
  await source.getBytes(0, 100);
  assert.ok(requests > 0);
});

test('getBytes returns verified, exactly-sized ArrayBuffers', async () => {
  const source = openSource();
  for (const [offset, length] of [
    [0, 4000],
    [900, 1200],
    [0, 1],
    [3995, 100], // clamped at EOF
  ] as const) {
    const { data, etag, cacheControl, expires } = await source.getBytes(offset, length);
    assert.ok(data instanceof ArrayBuffer);
    assert.equal(etag ?? cacheControl ?? expires, undefined, 'immutable content sets no cache hints');
    const want = mapBytes.subarray(offset, Math.min(offset + length, mapBytes.length));
    assert.deepEqual(new Uint8Array(data), new Uint8Array(want), `getBytes(${offset}, ${length})`);
  }
});

test('a failed bootstrap is retryable, not cached', async () => {
  let up = false;
  const inner = rangeFetch(fixture.files);
  const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!up) throw new TypeError('host down');
    return inner(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const source = new VerifiedSource({
    rootCid: fixture.rootCid,
    source: 'https://host.example',
    fetchFn: flaky,
  });
  await assert.rejects(source.getBytes(0, 100), AggregateError);
  up = true;
  const { data } = await source.getBytes(0, 100);
  assert.deepEqual(new Uint8Array(data), mapBytes.subarray(0, 100));
});

test('multiple hosts fail over in order', async () => {
  const down = (async () => {
    throw new TypeError('unreachable');
  }) as typeof fetch;
  const inner = rangeFetch(fixture.files);
  const routed = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://dead.example')) return down(url as never, init as never);
    return inner(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const source = new VerifiedSource({
    rootCid: fixture.rootCid,
    source: ['https://dead.example', 'https://live.example'],
    fetchFn: routed,
  });
  const { data } = await source.getBytes(0, 4000);
  assert.deepEqual(new Uint8Array(data), mapBytes);
});

test('opening with a wrong root CID fails reconstruction', async () => {
  const source = new VerifiedSource({
    rootCid: fixture.mapCid, // valid dag-pb CID, wrong anchor
    source: 'https://host.example',
    fetchFn: rangeFetch(fixture.files),
  });
  await assert.rejects(source.getBytes(0, 100), /does not reconstruct/);
});

test('missing metadata.json rejects', async () => {
  const files = new Map(fixture.files);
  files.delete('metadata.json');
  await assert.rejects(openSource({ files }).getBytes(0, 100), AggregateError);
});

test('stats count verified hashes and tampered rejections', async () => {
  const source = openSource();
  await source.getBytes(0, 4000);
  // proofs meta + shard + 3 leaves at minimum.
  assert.ok(source.stats.verified >= 5);
  assert.equal(source.stats.rejected, 0);

  const tampered = openSource({
    tamper: (path, range, bytes) => (path === 'map.pmtiles' && range ? flipByte(bytes) : bytes),
  });
  await assert.rejects(tampered.getBytes(0, 1000), AggregateError);
  assert.ok(tampered.stats.rejected > 0);
});

test('an aborted signal rejects the read', async () => {
  const source = openSource();
  await source.ready();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getBytes(0, 1000, controller.signal));
});

test('a tampered host is skipped for a clean mirror', async () => {
  const evil = rangeFetch(fixture.files, {
    tamper: (path, range, bytes) => (path === 'map.pmtiles' && range ? flipByte(bytes) : bytes),
  });
  const good = rangeFetch(fixture.files);
  const routed = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).startsWith('https://evil.example') ? evil : good;
    return target(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  const source = new VerifiedSource({
    rootCid: fixture.rootCid,
    source: ['https://evil.example', 'https://good.example'],
    fetchFn: routed,
  });
  const { data } = await source.getBytes(0, 4000);
  assert.deepEqual(new Uint8Array(data), mapBytes, 'verified bytes despite a tampering first host');
  assert.ok(source.stats.rejected > 0, 'the tampering host was caught');
});
