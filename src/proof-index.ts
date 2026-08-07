// Lazy, verified descent over the {proof}/ tree (PLAN-shards §1.2, §1.3).
// The descriptor anchors and carries the top meta; each meta names (by
// derived filename) and commits (by digest) its shard files and
// subdirectories; each shard carries the leaf digests for one contiguous
// byte range of the map file. Only the metas and shards covering a
// requested range are ever fetched, and every file's declared structure is
// checked against what its parent committed — the store's LRU makes the hot
// ones free.
//
// Shards need no client-side index: records are fixed-size, so each read
// binary-searches the digest-verified buffer the store already caches. A
// WeakSet marks buffers whose structure was validated — the mark holds no
// bytes and vanishes with the buffer when the LRU evicts it.

import {
  decodeMeta,
  KIND_DIR,
  type Leaf,
  SHARD_FILE_CAP,
  shardLeavesFor,
  shardName,
  validateShard,
} from './proof-format.ts';
import type { LeafIndex } from './ranged-reader.ts';
import type { VerifiedStore } from './verified-store.ts';
import { VerificationError } from './verify.ts';

// Meta files are capped by the format (and the descriptor cap for the top
// one); shard files carry the tighter format cap.
const META_FILE_CAP = 256 * 1024;

export class ProofIndex implements LeafIndex {
  #store: VerifiedStore;
  #fileSize: number;
  #topMeta: Uint8Array;
  #validated = new WeakSet<Uint8Array>();

  constructor(store: VerifiedStore, { topMeta, fileSize }: { topMeta: Uint8Array; fileSize: number }) {
    this.#store = store;
    this.#fileSize = fileSize;
    this.#topMeta = topMeta;
  }

  // The LeafIndex seam has no open step: the descriptor already verified the
  // top meta and committed the size. Kept for VerifiedFile's symmetry with
  // other indexes — cheap and idempotent.
  open(): Promise<number> {
    const { covered } = decodeMeta(this.#topMeta, 0);
    if (covered !== this.#fileSize) {
      throw new VerificationError(`top meta covers ${covered} bytes, expected ${this.#fileSize}`);
    }
    return Promise.resolve(this.#fileSize);
  }

  // Verified leaves, in file order, covering every leaf that overlaps
  // [start, end).
  async leavesFor(start: number, end: number, { signal }: { signal?: AbortSignal } = {}): Promise<Leaf[]> {
    const out: Leaf[] = [];
    await this.#collect('', 0, this.#fileSize, this.#topMeta, start, end, out, signal);
    return out;
  }

  // Same result, synchronously, when every covering meta and shard is
  // already in the byte cache — or null if anything would need the network.
  // Lets the map reader decide whether to race a speculative data fetch
  // against the async descent.
  cachedLeavesFor(start: number, end: number): Leaf[] | null {
    const out: Leaf[] = [];
    const hit = this.#collectCached('', 0, this.#fileSize, this.#topMeta, start, end, out);
    return hit ? out : null;
  }

  #collectCached(
    dirPath: string,
    dirStart: number,
    dirLength: number,
    metaBytes: Uint8Array,
    start: number,
    end: number,
    out: Leaf[],
  ): boolean {
    const { entries, covered } = decodeMeta(metaBytes, dirStart, start, end);
    if (covered !== dirLength) {
      throw new VerificationError(`${label(dirPath)} covers ${covered} bytes, expected ${dirLength}`);
    }
    for (const entry of entries) {
      const path = join(dirPath, shardName(entry.start));
      if (entry.kind === KIND_DIR) {
        const child = this.#store.getCached(entry.digest);
        if (child === undefined) return false;
        if (!this.#collectCached(path, entry.start, entry.length, child, start, end, out)) return false;
        continue;
      }
      const bytes = this.#store.getCached(entry.digest);
      if (bytes === undefined) return false;
      if (!this.#validated.has(bytes)) {
        validateShard(bytes, entry.length, path);
        this.#validated.add(bytes);
      }
      out.push(...shardLeavesFor(bytes, entry.start, entry.length, start, end));
    }
    return true;
  }

  async #collect(
    dirPath: string,
    dirStart: number,
    dirLength: number,
    metaBytes: Uint8Array,
    start: number,
    end: number,
    out: Leaf[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const { entries, covered } = decodeMeta(metaBytes, dirStart, start, end);
    if (covered !== dirLength) {
      throw new VerificationError(`${label(dirPath)} covers ${covered} bytes, expected ${dirLength}`);
    }
    for (const entry of entries) {
      const path = join(dirPath, shardName(entry.start));
      if (entry.kind === KIND_DIR) {
        const child = await this.#store.fetchWhole(`${path}/meta`, entry.digest, META_FILE_CAP, { signal });
        await this.#collect(path, entry.start, entry.length, child, start, end, out, signal);
        continue;
      }
      const bytes = await this.#store.fetchWhole(path, entry.digest, SHARD_FILE_CAP, { signal });
      if (!this.#validated.has(bytes)) {
        validateShard(bytes, entry.length, path);
        this.#validated.add(bytes);
      }
      out.push(...shardLeavesFor(bytes, entry.start, entry.length, start, end));
    }
  }
}

function join(dirPath: string, name: string): string {
  return dirPath === '' ? name : `${dirPath}/${name}`;
}

function label(dirPath: string): string {
  return dirPath === '' ? 'top meta' : `${dirPath}/meta`;
}
