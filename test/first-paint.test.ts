// First paint: what a cold client sends before any answer arrives. The open
// sends `root`, the first shard `0`, and the first read's exact range
// together; a cold read sends its metas, then all its shards at once, and
// only then its speculative content. Early bodies verify exactly like fresh
// ones: tamper is counted (a proof host banned), a 404 or an abort is a
// transport event, and an unneeded body is never used.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from '../src/verified-file.ts';
import { deterministicBytes, flipByte } from './helpers/bytes.ts';
import { gatedFetch, settle } from './helpers/gated-fetch.ts';
import { buildProofPackage, nestUnderDir, type ProofPackage } from './helpers/package.ts';
import { servePackage, type FileHostHooks } from './helpers/serve-file.ts';
import { scene } from './helpers/serve-hints.ts';

const FILE = 'https://h/map';
const K = 1024;
const cuts = (n: number) => Array.from({ length: n }, () => K);

// 20 one-KiB leaves in ten 2-leaf shards (0, 800, …, 4800), all in the top meta.
const flat = await buildProofPackage({ mapBytes: deterministicBytes(20 * K, 7), cuts: cuts(20), shardCap: 72 });
// 64 one-KiB leaves: shards 0…4800 in the top meta, the rest in eight
// directories of ≤ 3 shards (5000, 6800, 8000, 9800, b000, …).
const nested = await buildProofPackage({
  mapBytes: deterministicBytes(64 * K, 8),
  cuts: cuts(64),
  shardCap: 72,
  metaMaxEntries: 20,
});

// Labels shortened to proof paths and `bytes=a-b` content ranges.
const short = (label: string) => label.replace(`${FILE}.proofs/`, '').replace(`${FILE} `, '');
const range = (offset: number, length: number) => `bytes=${offset}-${offset + length - 1}`;
const slice = (pkg: ProofPackage, offset: number, length: number) => pkg.mapBytes.subarray(offset, offset + length);

function client(pkg: ProofPackage, hooks?: FileHostHooks) {
  const gate = gatedFetch(servePackage(FILE, pkg.mapBytes, pkg.proofs, hooks).fetch);
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, fetchFn: gate.fetchFn });
  return { gate, vf, issued: () => gate.issued.map(short) };
}

// An opened client whose next requests are held and logged from scratch.
async function opened(pkg: ProofPackage) {
  const c = client(pkg);
  c.gate.hold(false);
  await c.vf.ready();
  c.gate.hold(true);
  c.gate.issued.length = 0;
  return c;
}

// Two proof hosts for one file, every request logged in issue order.
function twoProofHosts(pkg: ProofPackage, firstHooks: FileHostHooks) {
  const P1 = 'https://p1/proofs';
  const P2 = 'https://p2/proofs';
  const h1 = servePackage(FILE, pkg.mapBytes, pkg.proofs, firstHooks, P1);
  const h2 = servePackage(FILE, pkg.mapBytes, pkg.proofs, {}, P2);
  const route = ((input: string, init?: RequestInit) =>
    (input.startsWith(P2) ? h2 : h1).fetch(input, init)) as typeof fetch;
  const gate = gatedFetch(route, { holds: () => false });
  const vf = new VerifiedFile({ cid: pkg.anchor, source: FILE, proof: [P1, P2], fetchFn: gate.fetchFn });
  const proofs = () => gate.issued.filter((u) => u.includes('/proofs/')).map((u) => u.replace('https://', ''));
  return { vf, proofs };
}

test('FP-01: a cold first read sends root, 0 and its exact range before root answers', async () => {
  const { gate, vf, issued } = client(flat);
  const leaf = flat.leaves[1]!; // in shard 0
  const read = vf.read(leaf.offset, leaf.length);
  await gate.until(() => gate.issued.length >= 3, 'three requests');
  await settle();
  const early = ['root', '0', range(leaf.offset, leaf.length)];
  assert.deepEqual(issued(), early);
  gate.hold(false);
  assert.deepEqual(await read, slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(issued(), early, 'both early bodies adopted: nothing fetched twice');
  assert.deepEqual(vf.stats, { verified: 3, rejected: 0 }, 'root, shard 0 and the leaf');
});

test('FP-02: flat tree — a cold read sends its shard, then its content', async () => {
  const { gate, vf, issued } = await opened(flat);
  const leaf = flat.leaves[6]!; // shard 1800
  const read = vf.read(leaf.offset, leaf.length);
  await gate.until(() => gate.issued.length >= 2, 'shard and content');
  await settle();
  assert.deepEqual(issued(), ['1800', range(leaf.offset, leaf.length)]);
  gate.hold(false);
  assert.deepEqual(await read, slice(flat, leaf.offset, leaf.length));
});

test('FP-03: nested tree — a cold read sends the meta, then the shard, and only then its content', async () => {
  const { gate, vf, issued } = await opened(nested);
  const leaf = nested.leaves[40]!; // shard a000 in directory 9800
  const read = vf.read(leaf.offset, leaf.length);
  await gate.until(() => gate.issued.length >= 1, 'the meta');
  await settle();
  assert.deepEqual(issued(), ['9800/meta'], 'nothing else until the meta answers');
  gate.release();
  await gate.until(() => gate.issued.length >= 3, 'shard and content');
  await settle();
  assert.deepEqual(issued(), ['9800/meta', '9800/a000', range(leaf.offset, leaf.length)]);
  gate.hold(false);
  assert.deepEqual(await read, slice(nested, leaf.offset, leaf.length));
});

test('FP-04: a read spanning several shards sends them all at once, then its content', async () => {
  const { gate, vf, issued } = await opened(flat);
  const read = vf.read(3 * K, 6 * K); // leaves 3–8: shards 800, 1000, 1800, 2000
  await gate.until(() => gate.issued.length >= 5, 'four shards and content');
  await settle();
  assert.deepEqual(issued(), ['800', '1000', '1800', '2000', range(3 * K, 6 * K)]);
  gate.hold(false);
  assert.deepEqual(await read, slice(flat, 3 * K, 6 * K));
});

test('FP-05: across directories, sibling metas go together, then every shard, then content', async () => {
  const { gate, vf, issued } = await opened(nested);
  const read = vf.read(42 * K, 4 * K); // shard a800 in 9800, shard b000 in b000
  await gate.until(() => gate.issued.length >= 2, 'both metas');
  await settle();
  assert.deepEqual(issued(), ['9800/meta', 'b000/meta']);
  gate.release();
  await gate.until(() => gate.issued.length >= 5, 'both shards and content');
  await settle();
  assert.deepEqual(issued(), ['9800/meta', 'b000/meta', '9800/a800', 'b000/b000', range(42 * K, 4 * K)]);
  gate.hold(false);
  assert.deepEqual(await read, slice(nested, 42 * K, 4 * K));
});

test('FP-06: a tampered early 0 is rejected, its proof host banned, and the next host serves', async () => {
  const { vf, proofs } = twoProofHosts(flat, { tamperProof: (p, b) => (p === '0' ? flipByte(b) : undefined) });
  const leaf = flat.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(vf.stats, { verified: 3, rejected: 1 });
  assert.deepEqual(proofs(), ['p1/proofs/root', 'p1/proofs/0', 'p2/proofs/0']);
  const next = flat.leaves[2]!; // shard 800
  assert.deepEqual(await vf.read(next.offset, next.length), slice(flat, next.offset, next.length));
  assert.deepEqual(proofs().slice(3), ['p2/proofs/800'], 'the tampering host is banned');
});

test('FP-07: a missing early 0 is a transport fault: no rejection, no ban', async () => {
  const { vf, proofs } = twoProofHosts(flat, { proofStatus: (p) => (p === '0' ? 404 : undefined) });
  const leaf = flat.leaves[0]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(vf.stats, { verified: 3, rejected: 0 });
  // The failed early response is dropped: `0` goes out fresh, then fails over.
  assert.deepEqual(proofs(), ['p1/proofs/root', 'p1/proofs/0', 'p1/proofs/0', 'p2/proofs/0']);
  const next = flat.leaves[2]!;
  await vf.read(next.offset, next.length);
  assert.deepEqual(proofs().slice(4), ['p1/proofs/800'], 'the first host still serves');
});

test('FP-08: a tampered early content body falls back to a verified fetch', async () => {
  let ranged = 0;
  const { gate, vf, issued } = client(flat, { tamperRange: (b) => (++ranged === 1 ? flipByte(b) : undefined) });
  gate.hold(false);
  const leaf = flat.leaves[1]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(vf.stats, { verified: 3, rejected: 1 });
  const content = range(leaf.offset, leaf.length);
  assert.deepEqual(issued(), ['root', '0', content, content], 'discarded, then fetched and verified');
});

test('FP-09: a top meta starting with a directory leaves the early 0 unused', async () => {
  const pkg = nestUnderDir(flat);
  // The host answers `{proof}/0` anyway (a listing, say): never checked, never counted.
  const proofs = new Map(pkg.proofs).set('0', deterministicBytes(100, 9));
  const { gate, vf, issued } = client({ ...pkg, proofs });
  gate.hold(false);
  const leaf = flat.leaves[1]!;
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(vf.stats, { verified: 4, rejected: 0 }, 'root, 0/meta, 0/0 and the leaf');
  assert.deepEqual(issued(), ['root', '0', range(leaf.offset, leaf.length), '0/meta', '0/0']);
});

test('FP-10: a hints-only client sends no early content', async () => {
  const DOC = 'https://page.example/hints.json';
  const H = 'https://node.example/map';
  const { fetchFn } = scene([{ fileUrl: H, bytes: flat.mapBytes, proofs: flat.proofs }], {
    [DOC]: { [flat.anchor]: [`${H}.proofs`], [flat.mapCid]: [H] },
  });
  const gate = gatedFetch(fetchFn, { holds: (label) => label.endsWith('/root') });
  const vf = new VerifiedFile({ cid: flat.anchor, hints: DOC, fetchFn: gate.fetchFn });
  const leaf = flat.leaves[1]!;
  const read = vf.read(leaf.offset, leaf.length);
  await gate.until(() => gate.issued.length >= 3, 'document, root and 0');
  await settle();
  assert.deepEqual(gate.issued, [DOC, `${H}.proofs/root`, `${H}.proofs/0`], 'no content before root answers');
  gate.hold(false);
  assert.deepEqual(await read, slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(gate.issued.slice(3), [`${H} ${range(leaf.offset, leaf.length)}`]);
});

test('FP-11: aborting the first read cancels its early content request, not the open', async () => {
  const { gate, vf, issued } = client(flat);
  const leaf = flat.leaves[1]!;
  const content = range(leaf.offset, leaf.length);
  const controller = new AbortController();
  const read = vf.read(leaf.offset, leaf.length, { signal: controller.signal });
  await gate.until(() => gate.issued.length >= 3, 'root, 0 and content');
  controller.abort();
  assert.deepEqual(gate.aborted.map(short), [content]);
  gate.hold(false);
  await assert.rejects(read, { name: 'AbortError' });
  assert.deepEqual(await vf.read(leaf.offset, leaf.length), slice(flat, leaf.offset, leaf.length));
  assert.deepEqual(issued(), ['root', '0', content, content], 'the open survived; the content went out afresh');
  assert.equal(vf.stats.rejected, 0);
});

test('FP-12: a read clamped at EOF leaves its early body unused', async () => {
  const { gate, vf, issued } = client(flat);
  gate.hold(false);
  const last = flat.leaves.at(-1)!; // shard 4800
  assert.deepEqual(await vf.read(last.offset, 2 * K), slice(flat, last.offset, K));
  assert.deepEqual(issued(), ['root', '0', range(last.offset, 2 * K), '4800', range(last.offset, K)]);
  assert.equal(vf.stats.rejected, 0);
});
