// Miniature map packages assembled with the CANONICAL IPLD implementations
// (multiformats + @ipld/dag-pb, dev-dependencies): every fixture root CID
// is computed by the reference stack, so a test that bootstraps one
// cross-validates the library's zero-dependency CID and dag-pb code against
// the real thing. The proof-tree shape mirrors the reference publisher
// build (left-shallow directories, ≤ cap shards).

import * as dagPb from '@ipld/dag-pb';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { KIND_DIR, KIND_SHARD, SHARD_FILE_CAP, SHARD_RECORD_SIZE, shardName } from '../../src/proof-format.ts';
import { sha256Bytes, sha256Hex } from './bytes.ts';
import { encodeMeta, encodeShard } from './proof-encode.ts';

const SHA2_256 = 0x12;
const RAW = 0x55;

export interface RawLeaf {
  offset: number;
  length: number;
  digest: Uint8Array;
}

export interface ProofFile {
  path: string;
  content: Uint8Array;
}

export interface MapPackage {
  rootCid: string;
  files: Map<string, Uint8Array>;
  leaves: RawLeaf[];
  metadataBytes: Uint8Array;
  /** A valid dag-pb CID that is not the root — the classic wrong-anchor. */
  mapCid: string;
}

export interface BuildOptions {
  mapBytes: Uint8Array;
  /** Leaf lengths, in file order; must sum to mapBytes.length. */
  cuts: number[];
  shardCap?: number;
  metaMaxEntries?: number;
  /** Extra root entries (beyond map.pmtiles/proofs) folded into the manifest and root node. */
  extraChildren?: { name: string; tsize: number }[];
}

export async function buildMapPackage({
  mapBytes,
  cuts,
  shardCap = SHARD_FILE_CAP,
  metaMaxEntries = 256,
  extraChildren = [],
}: BuildOptions): Promise<MapPackage> {
  const leaves = leavesFromCuts(mapBytes, cuts);
  const tree = buildProofTree(leaves, { shardCap, maxEntries: metaMaxEntries });

  const mapCid = CID.createV1(dagPb.code, Digest.create(SHA2_256, sha256Bytes(mapBytes)));
  const proofsCid = CID.createV1(dagPb.code, Digest.create(SHA2_256, sha256Bytes(tree.topMeta)));
  const children = [
    { name: 'map.pmtiles', cid: mapCid, tsize: mapBytes.length },
    { name: 'proofs', cid: proofsCid, tsize: tree.files.reduce((n, f) => n + f.content.length, 0) },
    ...extraChildren.map((c) => ({
      name: c.name,
      cid: CID.createV1(RAW, Digest.create(SHA2_256, sha256Bytes(new TextEncoder().encode(c.name)))),
      tsize: c.tsize,
    })),
  ];
  const manifest = {
    formatVersion: 2,
    hash: 'sha2-256',
    map: { file: 'map.pmtiles', size: mapBytes.length },
    proofs: { dir: 'proofs', metaDigest: sha256Hex(tree.topMeta), shardCapBytes: shardCap },
    children: children.map((c) => ({ name: c.name, cid: c.cid.toString(), tsize: c.tsize })),
  };
  const metadataBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const rootCid = await rootCidFor(children, metadataBytes);

  const files = new Map<string, Uint8Array>([
    ['map.pmtiles', mapBytes],
    ['metadata.json', metadataBytes],
    ...tree.files.map((f) => [`proofs/${f.path}`, f.content] as const),
  ]);
  return { rootCid, files, leaves, metadataBytes, mapCid: mapCid.toString() };
}

// The root directory node, built and hashed by the canonical stack.
export async function rootCidFor(
  children: { name: string; cid: CID; tsize: number }[],
  metadataBytes: Uint8Array,
): Promise<string> {
  const selfCid = CID.createV1(RAW, Digest.create(SHA2_256, sha256Bytes(metadataBytes)));
  const links = [
    ...children.map((c) => ({ Name: c.name, Hash: c.cid, Tsize: c.tsize })),
    { Name: 'metadata.json', Hash: selfCid, Tsize: metadataBytes.length },
  ].sort((a, b) => compareUtf8(a.Name, b.Name));
  const node = dagPb.encode({ Data: Uint8Array.of(0x08, 0x01), Links: links });
  return CID.createV1(dagPb.code, Digest.create(SHA2_256, sha256Bytes(node))).toString();
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

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
