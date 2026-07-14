// Lazy, verified descent over the proofs/ tree. metadata.json anchors the
// top meta's digest; each meta names (by derived filename) and commits (by
// digest) its shard files and subdirectories; each shard carries the leaf
// digests for one contiguous byte range of the map file. Only the metas and
// shards covering a requested range are ever fetched, and every file's
// declared structure is checked against what its parent committed — the
// store's LRU makes the hot ones free.
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
import type { VerifiedStore } from './verified-store.ts';
import { VerificationError } from './verify.ts';

// Meta files are single raw UnixFS leaves by build rule, so they are
// smaller than the 256 KiB chunking threshold — a hard read cap. Shard
// files carry the tighter format cap.
const META_FILE_CAP = 256 * 1024;

export class ProofIndex {
  #store: VerifiedStore;
  #dir: string;
  #fileSize: number;
  #topDigest: string;
  #validated = new WeakSet<Uint8Array>();

  constructor(
    store: VerifiedStore,
    { dir, metaDigest, fileSize }: { dir: string; metaDigest: string; fileSize: number },
  ) {
    this.#store = store;
    this.#dir = dir;
    this.#fileSize = fileSize;
    this.#topDigest = metaDigest;
  }

  // Verified leaves, in file order, covering every leaf that overlaps
  // [start, end).
  async leavesFor(start: number, end: number, { signal }: { signal?: AbortSignal } = {}): Promise<Leaf[]> {
    const out: Leaf[] = [];
    await this.#collect(this.#dir, 0, this.#fileSize, this.#topDigest, start, end, out, signal);
    return out;
  }

  // Same result, synchronously, when every covering meta and shard is
  // already in the byte cache — or null if anything would need the network.
  // Lets the map reader decide whether to race a speculative data fetch
  // against the async descent.
  cachedLeavesFor(start: number, end: number): Leaf[] | null {
    const out: Leaf[] = [];
    const hit = this.#collectCached(this.#dir, 0, this.#fileSize, this.#topDigest, start, end, out);
    return hit ? out : null;
  }

  #collectCached(
    dirPath: string,
    dirStart: number,
    dirLength: number,
    metaDigest: string,
    start: number,
    end: number,
    out: Leaf[],
  ): boolean {
    const metaBytes = this.#store.getCached(metaDigest);
    if (metaBytes === undefined) return false;
    const { entries, covered } = decodeMeta(metaBytes, dirStart, start, end);
    if (covered !== dirLength) {
      throw new VerificationError(`${dirPath}/meta covers ${covered} bytes, expected ${dirLength}`);
    }
    for (const entry of entries) {
      const path = `${dirPath}/${shardName(entry.start)}`;
      if (entry.kind === KIND_DIR) {
        if (!this.#collectCached(path, entry.start, entry.length, entry.digest, start, end, out)) {
          return false;
        }
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
    metaDigest: string,
    start: number,
    end: number,
    out: Leaf[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const metaBytes = await this.#store.fetchWhole(`${dirPath}/meta`, metaDigest, META_FILE_CAP, {
      signal,
    });
    const { entries, covered } = decodeMeta(metaBytes, dirStart, start, end);
    if (covered !== dirLength) {
      throw new VerificationError(`${dirPath}/meta covers ${covered} bytes, expected ${dirLength}`);
    }
    for (const entry of entries) {
      const path = `${dirPath}/${shardName(entry.start)}`;
      if (entry.kind === KIND_DIR) {
        await this.#collect(path, entry.start, entry.length, entry.digest, start, end, out, signal);
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
