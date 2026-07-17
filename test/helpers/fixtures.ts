// Shared fixture inputs for the verified-assets suite. Inputs are pinned
// (deterministic bytes, fixed seeds) so the frozen anchors in
// artifact-fixture.test.ts stay stable; every test file rebuilds the
// fixtures it needs from these definitions via the reference importer.

import { CarWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

import { type Artifact, buildArtifact, type TreeEntry } from './artifact.ts';
import { deterministicBytes } from './bytes.ts';

const CAR_CODE = 0x0202;

export const TREE_ENTRIES: TreeEntry[] = [
  { path: 'style.json', bytes: deterministicBytes(200, 11) },
  { path: 'Noto Sans Regular/0-255.pbf', bytes: deterministicBytes(2048, 12) },
  { path: 'fonts é/z.pbf', bytes: deterministicBytes(1024, 13) },
];

export const buildRaw = (): Promise<Artifact> => buildArtifact(deterministicBytes(1000, 1));
export const buildRawEmpty = (): Promise<Artifact> => buildArtifact(new Uint8Array(0));
export const buildRawMax = (): Promise<Artifact> => buildArtifact(deterministicBytes(262144, 2));
export const buildSplit = (): Promise<Artifact> => buildArtifact(deterministicBytes(262145, 3));
export const buildBig = (): Promise<Artifact> => buildArtifact(deterministicBytes(600 * 1024, 4));
export const buildTree = (): Promise<Artifact> => buildArtifact(TREE_ENTRIES);
export const buildDeep = (): Promise<Artifact> =>
  buildArtifact(deterministicBytes(512 * 1024, 6), { chunkSize: 1024, maxChildrenPerNode: 2 });

// A 32-segment tree and a 255-byte-named tree (A-W-06): purpose-built paths.
export const DEEP_PATH = Array.from({ length: 32 }, (_, i) => `d${i}`).join('/');
export const buildDeepPath = (): Promise<Artifact> =>
  buildArtifact([{ path: DEEP_PATH, bytes: deterministicBytes(64, 14) }]);
export const LONG_NAME = 'x'.repeat(255);
export const buildLongName = (): Promise<Artifact> =>
  buildArtifact([{ path: LONG_NAME, bytes: deterministicBytes(64, 15) }]);

// FIX-EMPTY-DIR: an empty directory has no importer entry, so hand-assemble
// the dag-pb node and wrap it in a one-section proof CAR.
export async function buildEmptyDir(): Promise<Artifact> {
  const node = dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [] });
  const rootCid = CID.createV1(dagPb.code, await sha256.digest(node));
  const proof = await carOf(rootCid, [{ cid: rootCid, bytes: node }]);
  const anchor = CID.createV1(CAR_CODE, await sha256.digest(proof));
  return { anchor: anchor.toString(), rootCid: rootCid.toString(), files: new Map(), proof };
}

async function carOf(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await drain;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const car = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    car.set(chunk, pos);
    pos += chunk.length;
  }
  return car;
}
