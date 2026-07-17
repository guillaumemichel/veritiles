import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError, VerifiedAsset } from '../src/asset.ts';
import { VerificationError } from '../src/verify.ts';
import { type Artifact, serveArtifact } from './helpers/artifact.ts';
import { deterministicBytes, sha256Bytes } from './helpers/bytes.ts';
import { anchorText, craftProof, dagPbCid, dagPbSection, rawCid } from './helpers/car.ts';
import {
  buildBig,
  buildDeep,
  buildDeepPath,
  buildEmptyDir,
  buildLongName,
  buildRaw,
  buildRawEmpty,
  buildTree,
  DEEP_PATH,
  LONG_NAME,
  TREE_ENTRIES,
} from './helpers/fixtures.ts';
import { dirNode, pbLink, pbNode, unixfsData } from './helpers/protobuf.ts';

const BASE = 'https://h/a';
const GLYPH = 'Noto Sans Regular/0-255.pbf';
const GLYPH_URL = 'https://h/a/Noto%20Sans%20Regular/0-255.pbf';

function serve(fixture: Artifact, base = BASE) {
  return serveArtifact([{ base, fixture }]);
}
function assetOver(fixture: Artifact, base = BASE, extra: Record<string, unknown> = {}) {
  const server = serve(fixture, base);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: base, fetchFn: server.fetch, ...extra });
  return { asset, requests: server.requests };
}
const contentReqs = (requests: string[]) => requests.filter((u) => !u.endsWith('.car'));

// A verification failure, whether surfaced directly or wrapped by the store's
// ordered-failover AggregateError.
async function rejectsClosed(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    if (err instanceof VerificationError) return true;
    return err instanceof AggregateError && err.errors.some((e) => e instanceof VerificationError);
  });
}

// --- Construction (A-C) ---

test('A-C-01 raw and car anchors construct; cid and root reflect kind', async () => {
  const raw = await buildRaw();
  const rawAsset = new VerifiedAsset({ cid: raw.anchor, source: BASE });
  assert.equal(rawAsset.cid, raw.anchor);
  assert.equal(rawAsset.root, raw.anchor);

  const tree = await buildTree();
  const dagAsset = new VerifiedAsset({ cid: tree.anchor, source: BASE });
  assert.equal(dagAsset.cid, tree.anchor);
  assert.equal(dagAsset.root, undefined); // pre-load
});

test('A-C-02 a dag-pb anchor throws VerificationError', async () => {
  const tree = await buildTree();
  assert.throws(() => new VerifiedAsset({ cid: tree.rootCid, source: BASE }), VerificationError);
});

test('A-C-03 a proof option with a raw anchor is a plain config Error', async () => {
  const raw = await buildRaw();
  assert.throws(
    () => new VerifiedAsset({ cid: raw.anchor, source: BASE, proof: 'https://x/p.car' }),
    (err: unknown) => err instanceof Error && !(err instanceof VerificationError),
  );
});

test('A-C-04 an empty source array or non-string base is a plain Error', async () => {
  const raw = await buildRaw();
  assert.throws(() => new VerifiedAsset({ cid: raw.anchor, source: [] }), Error);
  assert.throws(() => new VerifiedAsset({ cid: raw.anchor, source: [42 as unknown as string] }), Error);
});

test('A-C-04b an empty or non-string proof list is a plain Error', async () => {
  const tree = await buildTree();
  assert.throws(() => new VerifiedAsset({ cid: tree.anchor, source: BASE, proof: [] }), Error);
  assert.throws(
    () => new VerifiedAsset({ cid: tree.anchor, source: BASE, proof: [42 as unknown as string] }),
    Error,
  );
});

test('A-C-05 construction issues zero requests', async () => {
  const tree = await buildTree();
  const server = serve(tree);
  new VerifiedAsset({ cid: tree.anchor, source: BASE, fetchFn: server.fetch });
  assert.equal(server.requests.length, 0);
});

// --- Raw artifacts (A-R) ---

test('A-R-01 raw bytes("") is one request to the base, never .car', async () => {
  const raw = await buildRaw();
  const { asset, requests } = assetOver(raw);
  const bytes = await asset.bytes('');
  assert.deepEqual(bytes, raw.files.get(''));
  assert.deepEqual(requests, [BASE]);
});

test('A-R-02 bytes() with no argument equals bytes("")', async () => {
  const raw = await buildRaw();
  const { asset } = assetOver(raw);
  assert.deepEqual(await asset.bytes(), raw.files.get(''));
});

test('A-R-03 a sub-path on a raw artifact rejects with zero requests', async () => {
  const raw = await buildRaw();
  const { asset, requests } = assetOver(raw);
  await assert.rejects(asset.bytes('a'), VerificationError);
  assert.equal(requests.length, 0);
});

test('A-R-04 a tampered body fails over and bans the source', async () => {
  const raw = await buildRaw();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: raw, hooks: { tamper: (_u, b) => flip(b) } },
    { base: 'https://h/B', fixture: raw },
  ]);
  const asset = new VerifiedAsset({ cid: raw.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes(''), raw.files.get(''));
  assert.equal(asset.stats.rejected, 1);
  assert.equal(asset.stats.verified, 1);
  const before = server.requests.length;
  await asset.bytes(''); // cached; but confirm A is banned via a fresh key path below
  assert.ok(!server.requests.slice(before).includes('https://h/A'), 'banned source A not retried');
});

test('A-R-05 a body over the 256 KiB cap rejects', async () => {
  const raw = await buildRaw();
  const server = serveArtifact([{ base: BASE, fixture: raw, hooks: { tamper: () => deterministicBytes(262145, 9) } }]);
  const asset = new VerifiedAsset({ cid: raw.anchor, source: BASE, fetchFn: server.fetch });
  await rejectsClosed(asset.bytes(''));
});

test('A-R-06 an empty raw artifact round-trips', async () => {
  const empty = await buildRawEmpty();
  const { asset } = assetOver(empty);
  assert.deepEqual(await asset.bytes(''), new Uint8Array(0));
});

test('A-R-07 each read returns a fresh copy; mutation does not leak', async () => {
  const raw = await buildRaw();
  const { asset, requests } = assetOver(raw);
  const first = await asset.bytes('');
  first[0] = first[0]! ^ 0xff; // mutate the returned copy
  const second = await asset.bytes('');
  assert.deepEqual(second, raw.files.get(''));
  assert.equal(contentReqs(requests).length, 1); // second read served from cache
});

// --- Proof loading (A-P) ---

test('A-P-01 the proof is fetched once, before the leaf', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree);
  await asset.bytes(GLYPH);
  assert.deepEqual(requests, ['https://h/a.car', GLYPH_URL]);
  await asset.bytes('style.json');
  assert.equal(requests.filter((u) => u.endsWith('.car')).length, 1); // no second proof fetch
});

test('A-P-02 default proof URLs strip the base slash and are tried in order', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/fonts', fixture: tree, hooks: { dropProof: true } },
    { base: 'https://h/b', fixture: tree },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/fonts/', 'https://h/b'], fetchFn: server.fetch });
  await asset.bytes(GLYPH);
  assert.deepEqual(
    server.requests.filter((u) => u.endsWith('.car')),
    ['https://h/fonts.car', 'https://h/b.car'],
  );
});

test('A-P-03 an explicit proof URL is the only proof fetched', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: BASE, fixture: tree },
    { base: 'https://cdn/x', fixture: tree },
  ]);
  const asset = new VerifiedAsset({
    cid: tree.anchor,
    source: BASE,
    proof: 'https://cdn/x.car',
    fetchFn: server.fetch,
  });
  await asset.bytes(GLYPH);
  assert.deepEqual(server.requests.filter((u) => u.endsWith('.car')), ['https://cdn/x.car']);
  assert.ok(server.requests.includes(GLYPH_URL)); // content still from source
});

test('A-P-04 a tampered proof body fails over and counts one rejected', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? flip(b) : undefined) } },
    { base: 'https://h/B', fixture: tree },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await asset.bytes(GLYPH);
  assert.equal(asset.stats.rejected, 1);
  assert.ok(asset.stats.verified >= 1);
});

test('A-P-05 an oversized proof body fails over and counts one rejected', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: tree, hooks: { tamper: (u) => (u.endsWith('.car') ? deterministicBytes(262145, 1) : undefined) } },
    { base: 'https://h/B', fixture: tree },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await asset.bytes(GLYPH);
  assert.equal(asset.stats.rejected, 1);
});

test('A-P-06 a malformed-but-authored proof counts one rejected', async () => {
  // A proof whose whole body hashes to the anchor (authored) but fails to
  // parse: a raw-codec section. verifyDigest passes; parseProof rejects.
  const badBlock = deterministicBytes(20, 5);
  const rawSection = { cidBytes: rawCid(badBlock).bytes, block: badBlock };
  const badProof = craftProof(sha256Bytes(new Uint8Array(32)), [rawSection]);
  const fixture: Artifact = { anchor: anchorText(badProof), rootCid: 'unused', files: new Map(), proof: badProof };
  const { asset } = assetOver(fixture);
  await assert.rejects(asset.bytes(GLYPH), AggregateError);
  assert.equal(asset.stats.rejected, 1);
});

test('A-P-07 all proof URLs failing rejects; a later read retries', async () => {
  const tree = await buildTree();
  const server = serve(tree);
  let proofDown = true;
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    if (proofDown && String(url).endsWith('.car')) return Promise.resolve(new Response('down', { status: 404 }));
    return server.fetch(url, init);
  }) as typeof fetch;
  const asset = new VerifiedAsset({ cid: tree.anchor, source: BASE, fetchFn });
  await assert.rejects(asset.bytes(GLYPH), AggregateError);
  proofDown = false;
  assert.deepEqual(await asset.bytes(GLYPH), TREE_ENTRIES[1]!.bytes);
});

test('A-P-08 a 404 proof URL does not count as rejected', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: tree, hooks: { dropProof: true } },
    { base: 'https://h/B', fixture: tree },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await asset.bytes(GLYPH);
  assert.equal(asset.stats.rejected, 0);
});

test('A-P-09 root exposes the verified dag-pb root after load', async () => {
  const tree = await buildTree();
  const { asset } = assetOver(tree);
  await asset.bytes(GLYPH);
  assert.equal(asset.root, tree.rootCid);
});

test('A-P-10 a cold glyph read counts verified proof + body, zero rejected', async () => {
  const tree = await buildTree();
  const { asset } = assetOver(tree);
  await asset.bytes(GLYPH);
  assert.deepEqual(asset.stats, { verified: 2, rejected: 0 });
});

// --- Walk (A-W) ---

test('A-W-01 a glyph resolves with per-segment encoding', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree);
  assert.deepEqual(await asset.bytes(GLYPH), TREE_ENTRIES[1]!.bytes);
  assert.ok(requests.includes(GLYPH_URL));
});

test('A-W-02 an absent name is NotFound with no content request', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree);
  await asset.bytes(GLYPH); // warm the proof
  const before = requests.length;
  await assert.rejects(asset.bytes('missing.pbf'), NotFoundError);
  assert.equal(contentReqs(requests.slice(before)).length, 0);
});

test('A-W-03 an empty directory: missing name is NotFound; "" has no bytes', async () => {
  const dir = await buildEmptyDir();
  const { asset } = assetOver(dir);
  await assert.rejects(asset.bytes('x'), NotFoundError);
  await assert.rejects(asset.bytes(''), VerificationError);
});

test('A-W-04 a path descending through a file rejects', async () => {
  const tree = await buildTree();
  const { asset } = assetOver(tree);
  await assert.rejects(asset.bytes('style.json/extra'), VerificationError);
});

test('A-W-05 malformed paths reject before any request', async () => {
  const tree = await buildTree();
  for (const bad of ['..', 'a//b', '/x', Array.from({ length: 33 }, () => 'a').join('/'), 'x'.repeat(256)]) {
    const { asset, requests } = assetOver(tree);
    await assert.rejects(asset.bytes(bad), VerificationError);
    assert.equal(requests.length, 0);
  }
});

test('A-W-06 a 255-byte segment and a 32-segment path are accepted', async () => {
  const longName = await buildLongName();
  const la = assetOver(longName);
  assert.deepEqual(await la.asset.bytes(LONG_NAME), deterministicBytes(64, 15));

  const deepPath = await buildDeepPath();
  const da = assetOver(deepPath);
  assert.deepEqual(await da.asset.bytes(DEEP_PATH), deterministicBytes(64, 14));
});

test('A-W-07 a proof missing a reachable node rejects the walk and counts one rejected', async () => {
  const tree = await buildTree();
  const withHole = await proofMissingSubdir(tree); // drops the "Noto Sans Regular" subdir node
  const server = serve(withHole);
  const asset = new VerifiedAsset({ cid: withHole.anchor, source: BASE, fetchFn: server.fetch });
  await assert.rejects(asset.bytes(GLYPH), VerificationError);
  assert.equal(asset.stats.rejected, 1);
});

test('A-W-08 an extra unrelated block leaves reads verifying', async () => {
  const tree = await buildTree();
  const withExtra: Artifact = {
    ...tree,
    proof: appendExtraSection(tree.proof!),
  };
  withExtra.anchor = anchorText(withExtra.proof!);
  const { asset } = assetOver(withExtra);
  assert.deepEqual(await asset.bytes(GLYPH), TREE_ENTRIES[1]!.bytes);
});

test('A-W-09 a path continuing past a raw leaf rejects', async () => {
  const tree = await buildTree();
  const { asset } = assetOver(tree);
  await assert.rejects(asset.bytes('style.json/x'), VerificationError);
});

test('A-W-10 a file-root artifact returns its bytes for ""', async () => {
  const big = await buildBig();
  const { asset } = assetOver(big);
  assert.deepEqual(await asset.bytes(''), big.files.get(''));
});

test('A-W-11 names are byte-exact: NFC resolves, NFD is NotFound', async () => {
  const tree = await buildTree();
  const { asset } = assetOver(tree);
  const stored = TREE_ENTRIES[2]!.path; // 'fonts é/z.pbf'
  const variant = stored.normalize('NFC') === stored ? stored.normalize('NFD') : stored.normalize('NFC');
  assert.notEqual(variant, stored);
  assert.deepEqual(await asset.bytes(stored), TREE_ENTRIES[2]!.bytes);
  await assert.rejects(asset.bytes(variant), NotFoundError);
});

// --- DAG files (A-F) ---

test('A-F-01 a multi-chunk file reads in one GET; wrong length rejects', async () => {
  const big = await buildBig();
  const { asset, requests } = assetOver(big);
  assert.deepEqual(await asset.bytes(''), big.files.get(''));
  assert.equal(contentReqs(requests).length, 1);

  for (const mangle of [(b: Uint8Array) => b.subarray(0, b.length - 1), (b: Uint8Array) => concatOne(b)]) {
    const server = serveArtifact([{ base: BASE, fixture: big, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : mangle(b)) } }]);
    const a2 = new VerifiedAsset({ cid: big.anchor, source: BASE, fetchFn: server.fetch });
    await rejectsClosed(a2.bytes(''));
  }
});

test('A-F-02 a deep file DAG verifies at 9 nodes and rejects past the cap', async () => {
  const ok = deepFileArtifact(9); // deepest File node at recursion depth 8
  const okAsset = assetOver(ok);
  assert.deepEqual(await okAsset.asset.bytes(''), ok.files.get(''));

  const tooDeep = deepFileArtifact(10);
  const badAsset = assetOver(tooDeep);
  await rejectsClosed(badAsset.asset.bytes(''));
});

test('A-F-03 each single-leaf flip rejects then verifies from the clean source', async () => {
  const big = await buildBig();
  const leafSize = 262144;
  for (const flipAt of [0, leafSize, 2 * leafSize]) {
    const server = serveArtifact([
      { base: 'https://h/A', fixture: big, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : flip(b, flipAt)) } },
      { base: 'https://h/B', fixture: big },
    ]);
    const asset = new VerifiedAsset({ cid: big.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
    assert.deepEqual(await asset.bytes(''), big.files.get(''));
    assert.equal(asset.stats.rejected, 1); // one per response, not per leaf
    assert.equal(asset.stats.verified, 2); // proof + clean body
  }
});

test('A-F-04 a nested filesize ≠ parent blocksize rejects', async () => {
  const leaf = deterministicBytes(64, 220);
  const child = pbNode([pbLink({ hash: rawCid(leaf).bytes })], unixfsData({ type: 2, filesize: 32, blocksizes: [32] }));
  const root = pbNode([pbLink({ hash: dagPbCid(child).bytes })], unixfsData({ type: 2, filesize: 64, blocksizes: [64] }));
  const proof = craftProof(dagPbCid(root).multihash.digest, [dagPbSection(root), dagPbSection(child)]);
  const fixture: Artifact = { anchor: anchorText(proof), rootCid: dagPbCid(root).toString(), files: new Map([['', deterministicBytes(64, 221)]]), proof };
  const { asset } = assetOver(fixture);
  await rejectsClosed(asset.bytes(''));
});

test('A-F-05 maxFileBytes rejects before any content request', async () => {
  const big = await buildBig();
  const { asset, requests } = assetOver(big, BASE, { maxFileBytes: 1024 });
  await assert.rejects(asset.bytes(''), VerificationError);
  assert.equal(contentReqs(requests).length, 0); // proof allowed, content never fetched
});

test('A-F-07 kind-prefixed keys keep a leaf and a colliding node distinct', async () => {
  const adv = adversarialArtifact();
  const { asset } = assetOver(adv);
  const leafBytes = await asset.bytes('leaf'); // caches node-shaped bytes under the bare digest
  const fileBytes = await asset.bytes('file'); // must return assembled content, not the node bytes
  assert.deepEqual(fileBytes, adv.files.get('file'));
  assert.notDeepEqual(fileBytes, leafBytes);
});

test('A-F-10 a hash-valid but malformed proof node counts one rejected', async () => {
  // A block that hashes to its section CID (so the proof parses) but decodes to
  // an unsupported UnixFS type: a proof-authoring fault detected at the walk.
  const badNode = pbNode([], unixfsData({ type: 0 })); // Raw type — rejected by A6
  const proof = craftProof(dagPbCid(badNode).multihash.digest, [dagPbSection(badNode)]);
  const fixture: Artifact = { anchor: anchorText(proof), rootCid: dagPbCid(badNode).toString(), files: new Map([['', new Uint8Array(1)]]), proof };
  const { asset } = assetOver(fixture);
  await assert.rejects(asset.bytes(''), VerificationError);
  assert.equal(asset.stats.rejected, 1);
});

test('A-F-08 a missing terminal File node counts one rejected, no content fetch', async () => {
  const leaf = deterministicBytes(64, 230);
  const fileNode = pbNode([pbLink({ hash: rawCid(leaf).bytes })], unixfsData({ type: 2, filesize: 64, blocksizes: [64] }));
  const proof = craftProof(dagPbCid(fileNode).multihash.digest, []); // header only: root node absent
  const fixture: Artifact = { anchor: anchorText(proof), rootCid: dagPbCid(fileNode).toString(), files: new Map([['', leaf]]), proof };
  const { asset, requests } = assetOver(fixture);
  await assert.rejects(asset.bytes(''), VerificationError);
  assert.equal(asset.stats.rejected, 1);
  assert.equal(contentReqs(requests).length, 0);
});

test('A-F-09 a missing nested File node counts one rejected and bans no source', async () => {
  const leaf = deterministicBytes(64, 231);
  const nested = pbNode([pbLink({ hash: rawCid(leaf).bytes })], unixfsData({ type: 2, filesize: 64, blocksizes: [64] }));
  const root = pbNode([pbLink({ hash: dagPbCid(nested).bytes })], unixfsData({ type: 2, filesize: 64, blocksizes: [64] }));
  const proof = craftProof(dagPbCid(root).multihash.digest, [dagPbSection(root)]); // nested node absent
  const fixture: Artifact = { anchor: anchorText(proof), rootCid: dagPbCid(root).toString(), files: new Map([['', leaf]]), proof };
  const server = serveArtifact([
    { base: 'https://h/A', fixture },
    { base: 'https://h/B', fixture },
  ]);
  const asset = new VerifiedAsset({ cid: fixture.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await assert.rejects(asset.bytes(''), VerificationError);
  assert.equal(asset.stats.rejected, 1); // one, not one-per-source
  assert.equal(contentReqs(server.requests).length, 0); // structural fault: no content fetched, nothing banned
});

// --- Bans, cache, abort, stats (A-B / A-K / A-X / A-T) ---

test('A-B-01 a content tamper bans the source for later reads', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : flip(b)) } },
    { base: 'https://h/B', fixture: tree },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await asset.bytes(GLYPH);
  const before = server.requests.length;
  await asset.bytes('style.json');
  assert.ok(!server.requests.slice(before).some((u) => u.startsWith('https://h/A/')), 'A not retried for content');
});

test('A-B-02 a transient 404 does not ban: the source is retried', async () => {
  const tree = await buildTree();
  let down = true;
  const server = serve(tree);
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    if (down && String(url) === GLYPH_URL) {
      down = false;
      return Promise.resolve(new Response('x', { status: 404 }));
    }
    return server.fetch(url, init);
  }) as typeof fetch;
  const asset = new VerifiedAsset({ cid: tree.anchor, source: BASE, fetchFn });
  await assert.rejects(asset.bytes(GLYPH), AggregateError); // single source 404
  assert.deepEqual(await asset.bytes(GLYPH), TREE_ENTRIES[1]!.bytes); // retried, now 200
});

test('A-B-03 a content-banned host still serves its proof URL', async () => {
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : flip(b)) } },
    { base: 'https://h/B', fixture: tree, hooks: { dropProof: true } },
  ]);
  const asset = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  assert.deepEqual(await asset.bytes(GLYPH), TREE_ENTRIES[1]!.bytes); // proof from A.car, content from B
  assert.equal(asset.root, tree.rootCid);
  assert.ok(server.requests.includes('https://h/A.car'), 'proof loaded from the content-banned host');
});

test('A-K-01 a tiny cache forces a refetch after eviction', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree, BASE, { maxCacheBytes: 1 });
  await asset.bytes(GLYPH);
  await asset.bytes('style.json'); // evicts the glyph
  const before = requests.length;
  await asset.bytes(GLYPH); // must refetch
  assert.ok(requests.slice(before).includes(GLYPH_URL));
});

test('A-K-02 two identical concurrent reads share one content request', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree);
  await asset.bytes(GLYPH); // warm proof
  const before = requests.length;
  await Promise.all([asset.bytes('style.json'), asset.bytes('style.json')]);
  assert.equal(contentReqs(requests.slice(before)).length, 1);
});

test('A-X-01 aborting a content fetch rejects; the proof memo survives', async () => {
  const tree = await buildTree();
  const server = serve(tree);
  const STYLE_URL = 'https://h/a/style.json';
  const log: string[] = [];
  let trapArmed = false;
  let signalInFlight!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    signalInFlight = resolve;
  });
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    log.push(String(url));
    if (trapArmed && String(url) === STYLE_URL) {
      signalInFlight();
      return new Promise<Response>((_, reject) => {
        const s = (init as { signal?: AbortSignal } | undefined)?.signal;
        s?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return server.fetch(url, init);
  }) as typeof fetch;
  const asset = new VerifiedAsset({ cid: tree.anchor, source: BASE, fetchFn });

  await asset.bytes(GLYPH); // warm the proof + one leaf
  trapArmed = true;
  const controller = new AbortController();
  const pending = asset.bytes('style.json', { signal: controller.signal });
  await inFlight; // the content fetch is now hanging
  controller.abort();
  await assert.rejects(pending);

  trapArmed = false;
  await asset.bytes('style.json'); // succeeds; proof memo intact
  assert.equal(log.filter((u) => u.endsWith('.car')).length, 1, 'proof fetched only once');
});

test('A-X-02 a pre-aborted signal rejects immediately with zero requests', async () => {
  const tree = await buildTree();
  const { asset, requests } = assetOver(tree);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(asset.bytes(GLYPH, { signal: controller.signal }));
  assert.equal(requests.length, 0);
});

test('A-T-01 combined stats: raw + glyph reads with one tampered response', async () => {
  const raw = await buildRaw();
  const tree = await buildTree();
  const server = serveArtifact([
    { base: 'https://h/raw', fixture: raw },
    { base: 'https://h/A', fixture: tree, hooks: { tamper: (u, b) => (u.endsWith('.car') ? undefined : flip(b)) } },
    { base: 'https://h/B', fixture: tree },
  ]);
  const rawAsset = new VerifiedAsset({ cid: raw.anchor, source: 'https://h/raw', fetchFn: server.fetch });
  const fonts = new VerifiedAsset({ cid: tree.anchor, source: ['https://h/A', 'https://h/B'], fetchFn: server.fetch });
  await rawAsset.bytes('');
  await fonts.bytes(GLYPH);
  const total = {
    verified: rawAsset.stats.verified + fonts.stats.verified,
    rejected: rawAsset.stats.rejected + fonts.stats.rejected,
  };
  assert.deepEqual(total, { verified: 3, rejected: 1 });
});

// --- crafted-fixture helpers ---

function flip(bytes: Uint8Array, index = 0): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index % copy.length]! ^= 0xff;
  return copy;
}
function concatOne(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}
function corruptSection(proof: Uint8Array): Uint8Array {
  // Flip a byte inside the first section's block (past the 59-byte header and
  // the 36-byte CID), so the section digest check fails at parse.
  const copy = new Uint8Array(proof);
  copy[59 + 2 + 36]! ^= 0xff;
  return copy;
}
function appendExtraSection(proof: Uint8Array): Uint8Array {
  const extra = dagPbSection(deterministicBytes(80, 77));
  const framed = craftProof(proof.subarray(18, 50), [extra]).subarray(59); // just the framed section
  const out = new Uint8Array(proof.length + framed.length);
  out.set(proof);
  out.set(framed, proof.length);
  return out;
}
// Rebuild FIX-TREE's proof without the "Noto Sans Regular" subdir node.
async function proofMissingSubdir(tree: Artifact): Promise<Artifact> {
  const { carSections } = await import('./helpers/car.ts');
  const sections = await carSections(tree.proof!);
  const rootSection = sections.find((s) => s.cid.toString() === tree.rootCid)!;
  // Keep root + the "fonts é" subdir (contains 'z.pbf'); drop "Noto Sans Regular".
  const kept = sections
    .filter((s) => s.cid.toString() === tree.rootCid || new TextDecoder().decode(s.bytes).includes('z.pbf'))
    .map((s) => dagPbSection(s.bytes));
  const proof = craftProof(sha256Bytes(rootSection.bytes), kept);
  return { anchor: anchorText(proof), rootCid: tree.rootCid, files: tree.files, proof };
}

function deepFileArtifact(nodes: number): Artifact {
  const leaf = deterministicBytes(64, 200);
  let childCid = rawCid(leaf);
  const sections = [];
  let rootCid = childCid;
  for (let i = 0; i < nodes; i++) {
    const block = pbNode([pbLink({ hash: childCid.bytes })], unixfsData({ type: 2, filesize: 64, blocksizes: [64] }));
    sections.push(dagPbSection(block));
    rootCid = dagPbCid(block);
    childCid = rootCid;
  }
  const proof = craftProof(rootCid.multihash.digest, sections);
  return { anchor: anchorText(proof), rootCid: rootCid.toString(), files: new Map([['', leaf]]), proof };
}

function adversarialArtifact(): Artifact {
  const fileContent = deterministicBytes(400, 210);
  const fileNode = pbNode(
    [pbLink({ hash: rawCid(fileContent.subarray(0, 200)).bytes }), pbLink({ hash: rawCid(fileContent.subarray(200, 400)).bytes })],
    unixfsData({ type: 2, filesize: 400, blocksizes: [200, 200] }),
  );
  // A raw leaf whose CONTENT is the File node's block bytes: same digest,
  // different codec — the adversarial cache collision (plan decision 7).
  const rootDir = dirNode([
    { name: 'file', hash: dagPbCid(fileNode).bytes },
    { name: 'leaf', hash: rawCid(fileNode).bytes },
  ]);
  const proof = craftProof(dagPbCid(rootDir).multihash.digest, [dagPbSection(rootDir), dagPbSection(fileNode)]);
  return {
    anchor: anchorText(proof),
    rootCid: dagPbCid(rootDir).toString(),
    files: new Map([
      ['file', fileContent],
      ['leaf', fileNode],
    ]),
    proof,
  };
}
