// Miniature verified packages: content bytes + meta/shard proof tree +
// dag-cbor descriptor. The map CID is the raw whole-file content binding.
// The proof-tree shape mirrors the reference publisher build (left-shallow
// directories, ≤ cap shards).

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { encodeDescriptor } from '../../src/descriptor.ts';
import { KIND_DIR, KIND_SHARD, SHARD_FILE_CAP, SHARD_RECORD_SIZE, shardName } from '../../src/proof-format.ts';
import { sha256Bytes } from './bytes.ts';
import { encodeMeta, encodeShard } from '../../src/proof-format.ts';

const SHA2_256 = 0x12;
const DAG_CBOR = 0x71;

export interface RawLeaf {
  offset: number;
  length: number;
  digest: Uint8Array;
}

export interface ProofFile {
  path: string;
  content: Uint8Array;
}

export interface ProofPackage {
  /** The VerifiedFile anchor: CIDv1(dag-cbor, sha2-256(descriptor)). */
  anchor: string;
  /** The map's raw whole-file CID — the descriptor's content binding. */
  mapCid: string;
  descriptor: Uint8Array;
  /** Proof-base-relative files: 'root', '{hex}', '{hex}/meta', … */
  proofs: Map<string, Uint8Array>;
  mapBytes: Uint8Array;
  leaves: RawLeaf[];
}

export interface BuildOptions {
  mapBytes: Uint8Array;
  /** Leaf lengths, in file order; must sum to mapBytes.length. */
  cuts: number[];
  shardCap?: number;
  metaMaxEntries?: number;
}

export async function buildProofPackage({
  mapBytes,
  cuts,
  shardCap = SHARD_FILE_CAP,
  metaMaxEntries = 256,
}: BuildOptions): Promise<ProofPackage> {
  const leaves = leavesFromCuts(mapBytes, cuts);
  const tree = buildProofTree(leaves, { shardCap, maxEntries: metaMaxEntries });
  const mapCid = CID.createV1(0x55, Digest.create(SHA2_256, sha256Bytes(mapBytes)));
  const mapCidBytes = mapCid.bytes;
  const descriptor = encodeDescriptor({ mapCidBytes, topMeta: tree.topMeta, mapSize: mapBytes.length });
  const anchor = CID.createV1(DAG_CBOR, Digest.create(SHA2_256, sha256Bytes(descriptor))).toString();
  // The top meta travels inside the descriptor — it is never a hosted file.
  const proofs = new Map<string, Uint8Array>([['root', descriptor]]);
  for (const file of tree.files) {
    if (file.path !== 'meta') proofs.set(file.path, file.content);
  }
  return { anchor, mapCid: mapCid.toString(), descriptor, proofs, mapBytes, leaves };
}

export function leavesFromCuts(mapBytes: Uint8Array, cuts: number[]): RawLeaf[] {
  const leaves: RawLeaf[] = [];
  let offset = 0;
  for (const length of cuts) {
    leaves.push({
      offset,
      length,
      digest: sha256Bytes(mapBytes.subarray(offset, offset + length)),
    });
    offset += length;
  }
  if (offset !== mapBytes.length) {
    throw new Error(`cuts cover ${offset} bytes, file is ${mapBytes.length}`);
  }
  return leaves;
}

// Pack leaf digests into ≤ cap shard files in file order, then shape
// directories left-shallow: earliest ranges stay at the top, the tail nests
// into subdirectories. Ported from the reference publisher build; the
// client never depends on the shape.
export function buildProofTree(
  leaves: RawLeaf[],
  { shardCap = SHARD_FILE_CAP, maxEntries = 256 }: { shardCap?: number; maxEntries?: number } = {},
): { files: ProofFile[]; topMeta: Uint8Array; shardCount: number } {
  if (leaves.length === 0) throw new Error('no leaves to prove');
  if (maxEntries < 2) throw new Error('maxEntries must be at least 2');

  const perShard = Math.floor(shardCap / SHARD_RECORD_SIZE);
  if (perShard < 1) throw new Error(`shard cap ${shardCap} is below one record`);
  const shards: { start: number; length: number; content: Uint8Array }[] = [];
  for (let i = 0; i < leaves.length; i += perShard) {
    const group = leaves.slice(i, i + perShard);
    const start = group[0]!.offset;
    shards.push({
      start,
      length: group.reduce((n, l) => n + l.length, 0),
      content: encodeShard(group, start),
    });
  }

  const files: ProofFile[] = [];
  const top = emitDir(shards, '', files, maxEntries);
  files.push({ path: 'meta', content: top });
  return { files, topMeta: top, shardCount: shards.length };
}

type Shard = { start: number; length: number; content: Uint8Array };

function emitDir(shards: Shard[], prefix: string, files: ProofFile[], maxEntries: number): Uint8Array {
  let head = shards;
  const dirEntries: { kind: number; length: number; digest: Uint8Array }[] = [];
  if (shards.length > maxEntries) {
    const headCount = Math.floor(maxEntries / 2);
    head = shards.slice(0, headCount);
    const rest = shards.slice(headCount);
    const groupSize = Math.ceil(rest.length / (maxEntries - headCount));
    for (let i = 0; i < rest.length; i += groupSize) {
      const group = rest.slice(i, i + groupSize);
      const dirName = shardName(group[0]!.start);
      const meta = emitDir(group, `${prefix}${dirName}/`, files, maxEntries);
      files.push({ path: `${prefix}${dirName}/meta`, content: meta });
      dirEntries.push({
        kind: KIND_DIR,
        length: group.reduce((n, s) => n + s.length, 0),
        digest: sha256Bytes(meta),
      });
    }
  }
  for (const shard of head) {
    files.push({ path: `${prefix}${shardName(shard.start)}`, content: shard.content });
  }
  return encodeMeta([
    ...head.map((s) => ({ kind: KIND_SHARD, length: s.length, digest: sha256Bytes(s.content) })),
    ...dirEntries,
  ]);
}
