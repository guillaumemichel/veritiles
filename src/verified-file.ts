// The public entry point for range-verified files (PLAN-shards §1): a file
// anchored to a dag-cbor proof descriptor, read over one or more untrusted
// hosts. Construction is synchronous; the first read lazily fetches
// `{proof}/root` (verifying it against the anchor — the one hash at open)
// and a failed open stays retryable. Reads clamp at EOF and return a fresh,
// exact-size copy — the content type (PMTiles, video, any file) is
// irrelevant to this class; per-type knowledge lives entirely in the
// packer.

import { type Cid, parseFileAnchor } from './cid.ts';
import { openDescriptor } from './descriptor.ts';
import { DEFAULT_MAX_CACHE_BYTES, PROOF_CACHE_BYTES } from './limits.ts';
import { ProofIndex } from './proof-index.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { RangedReader } from './ranged-reader.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';

export interface VerifiedFileOptions {
  /** Anchor CID (PLAN-shards §1.1): dag-cbor, sha2-256 of the proof descriptor. */
  cid: string;
  /** URL(s) of the file itself, tried in order. Range + 206 required. */
  source: string | string[];
  /**
   * Proof base URL(s) — the directory holding `root` and the meta/shard
   * tree — tried in order. Default `{source}.proofs` per source; an
   * explicit value is required when a source URL carries a query string.
   */
  proof?: string | string[];
  /** Replaces global fetch — instrumentation and test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte LRU cache (default 64 MiB). */
  maxCacheBytes?: number;
}

export class VerifiedFile {
  #cid: string;
  #anchor: Cid;
  #store: VerifiedStore;
  #proofStore: VerifiedStore;
  #reader: Promise<RangedReader> | undefined;
  #size: number | undefined;

  constructor(options: VerifiedFileOptions) {
    const { cid, source, proof, fetchFn, maxCacheBytes } = options;
    this.#anchor = parseFileAnchor(cid);
    this.#cid = cid;

    const sources = Array.isArray(source) ? source : [source];
    if (sources.length === 0 || sources.some((s) => typeof s !== 'string' || s.length === 0)) {
      throw new Error('source must be a URL or a non-empty list of URLs');
    }
    const fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    const proofBases = this.#proofBases(sources, proof);

    this.#store = new VerifiedStore(
      sources.map((base) => new RangeSource(base, { fetchFn: fetch })),
      { maxCacheBytes: maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES },
    );
    // Proof files share the stats object (one {verified, rejected} pair per
    // client) but get their own small LRU: proofs are tiny and immutable.
    this.#proofStore = new VerifiedStore(
      proofBases.map((base) => new RangeSource(base, { fetchFn: fetch })),
      { maxCacheBytes: PROOF_CACHE_BYTES, stats: this.#store.stats },
    );
  }

  #proofBases(sources: string[], proof: string | string[] | undefined): string[] {
    if (proof !== undefined) {
      const urls = Array.isArray(proof) ? proof : [proof];
      if (urls.length === 0 || urls.some((u) => typeof u !== 'string' || u.length === 0)) {
        throw new Error('proof must be a URL or a non-empty list of URLs');
      }
      return urls;
    }
    return sources.map((s) => {
      if (s.includes('?')) throw new Error(`source ${s} has a query string; an explicit proof URL is required`);
      return `${s}.proofs`;
    });
  }

  get cid(): string {
    return this.#cid;
  }

  get size(): number | undefined {
    return this.#size;
  }

  get stats(): VerifyStats {
    return this.#store.stats;
  }

  // Open eagerly instead of on the first read — optional; surfaces a bad anchor
  // or unreachable proof host before the first byte is needed.
  async ready(): Promise<void> {
    await this.#open();
  }

  // Verified bytes for [offset, offset + length), clamped to EOF.
  async read(offset: number, length: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const reader = await this.#open();
    return reader.read(offset, length, { signal });
  }

  // Lazy memoized open: verify the descriptor, seed the proof index, build
  // the read loop. A failure clears the memo so the next read retries
  // (the proof store owns proof-base failover); deliberately not tied to
  // any caller's abort signal.
  #open(): Promise<RangedReader> {
    if (this.#reader === undefined) {
      this.#reader = (async () => {
        const descriptor = await openDescriptor(this.#anchor, this.#proofStore);
        const index = new ProofIndex(this.#proofStore, {
          topMeta: descriptor.topMeta,
          fileSize: descriptor.mapSize,
        });
        const size = await index.open();
        this.#size = size;
        return new RangedReader(this.#store, index, '', size);
      })();
      this.#reader.catch(() => {
        this.#reader = undefined;
      });
    }
    return this.#reader;
  }
}
