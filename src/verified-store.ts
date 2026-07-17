// The one verification choke point over an ordered list of byte sources: a
// digest-keyed LRU cache, in-flight de-duplication, strict verification,
// verified/rejected stats, and ordered failover (a source that returns wrong
// or missing bytes is skipped in favour of the next). Sources hand up
// UNVERIFIED bytes; nothing leaves here unverified except fetchUnverified,
// whose single caller (bootstrap) authenticates the bytes afterwards by
// reconstructing the root CID from them.

import type { Leaf } from './proof-format.ts';
import { VerificationError, verifyDigest } from './verify.ts';

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export interface ByteSource {
  fetchWhole(path: string, cap: number, opts?: { signal?: AbortSignal }): Promise<Uint8Array>;
  fetchRange(
    path: string,
    start: number,
    length: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
}

export interface VerifyStats {
  verified: number;
  rejected: number;
}

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
}

export class VerifiedStore {
  #sources: ByteSource[];
  #cache = new Map<string, Uint8Array>(); // cache key -> bytes, insertion order = LRU
  #cacheBytes = 0;
  #maxCacheBytes: number;
  #inflight = new Map<string, Inflight>();
  // Sources that served bytes failing verification: tampering, not transport.
  // Skipped by every fetch loop for the store's lifetime (A8, ban on tamper).
  #banned = new Set<ByteSource>();
  stats: VerifyStats = { verified: 0, rejected: 0 };

  constructor(sources: ByteSource[], { maxCacheBytes = DEFAULT_CACHE_BYTES }: { maxCacheBytes?: number } = {}) {
    if (!sources?.length) throw new Error('at least one source is required');
    this.#sources = sources;
    this.#maxCacheBytes = maxCacheBytes;
  }

  // Verified cached bytes for a digest (LRU-refreshed), or undefined. Lets
  // the map reader plan which leaves still need fetching and split runs.
  getCached(digest: string): Uint8Array | undefined {
    const bytes = this.#cache.get(digest);
    if (bytes === undefined) return undefined;
    this.#cache.delete(digest);
    this.#cache.set(digest, bytes);
    return bytes;
  }

  // Verified whole small file with a caller-supplied check in place of the
  // fixed digest compare — the primitive behind both a digest-keyed raw read
  // and a UnixFS file read whose bytes are verified against proof structure.
  // Same plain GET, cache, in-flight dedup, ordered failover, stats, and bans.
  async fetchChecked(
    path: string,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<void>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const cached = this.getCached(cacheKey);
    if (cached !== undefined) return cached;
    return this.#dedup(`whole:${cacheKey}`, signal, (s) => this.#fetchCheckedFrom(path, cacheKey, cap, check, s));
  }

  // Verified whole small file (proof shard, meta) with a known digest:
  // plain GET, hash compare, digest-keyed cache + dedup.
  async fetchWhole(
    path: string,
    digest: string,
    cap: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    return this.fetchChecked(path, digest, cap, (bytes) => verifyDigest(digest, bytes, path), { signal });
  }

  // Verified slices for a run of file-contiguous leaves, aligned with
  // `leaves`. One Range request per run; every slice is verified before any
  // is cached, so one bad leaf sends the whole run to the next source
  // instead of poisoning the cache. Concurrent identical runs share one
  // fetch + one verification pass.
  async fetchRun(path: string, leaves: Leaf[], { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array[]> {
    signal?.throwIfAborted();
    const start = leaves[0]!.offset;
    const total = leaves.reduce((n, l) => n + l.length, 0);
    return this.#dedup(`run:${path}:${start}+${total}`, signal, (s) =>
      this.#fetchRunFrom(path, leaves, start, total, s),
    );
  }

  // UNVERIFIED ranged body — the speculative half of a parallel read: fetched
  // while the proof descent is still in flight, then adopted leaf-by-leaf via
  // adoptSlices once digests are known, or discarded. Never cached here.
  async fetchRangeUnverified(
    path: string,
    start: number,
    length: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    return this.#dedup(`spec:${path}:${start}+${length}`, signal, async (s) => {
      const errors: unknown[] = [];
      for (const source of this.#sources) {
        if (this.#banned.has(source)) continue;
        try {
          return await source.fetchRange(path, start, length, { signal: s });
        } catch (err) {
          if (s.aborted) throw err;
          errors.push(err);
        }
      }
      throw new AggregateError(errors, `all sources failed for ${path}`);
    });
  }

  // Verified slices for file-contiguous leaves cut from an UNVERIFIED
  // speculative body (body[0] is file offset bodyStart): every slice is
  // digest-checked before any is cached, so a bad body poisons nothing —
  // the caller falls back to an ordinary verified run fetch.
  async adoptSlices(
    leaves: Leaf[],
    body: Uint8Array,
    bodyStart: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array[]> {
    signal?.throwIfAborted();
    try {
      const slices = leaves.map((leaf) => {
        const from = leaf.offset - bodyStart;
        return body.slice(from, from + leaf.length); // copy: no shared-buffer retention
      });
      for (let i = 0; i < leaves.length; i++) {
        if (slices[i]!.length !== leaves[i]!.length) {
          throw new VerificationError(`speculative body truncated at ${leaves[i]!.offset}`);
        }
        await verifyDigest(leaves[i]!.digest, slices[i]!, `speculative@${leaves[i]!.offset}`);
      }
      for (let i = 0; i < leaves.length; i++) {
        this.stats.verified++;
        this.#cachePut(leaves[i]!.digest, slices[i]!);
      }
      return slices;
    } catch (err) {
      if (err instanceof VerificationError) this.stats.rejected++;
      throw err;
    }
  }

  // UNVERIFIED whole file — bootstrap only: metadata.json cannot be checked
  // until its own bytes rebuild the root CID. Never cached here.
  async fetchUnverified(path: string, cap: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    return this.#dedup(`raw:${path}`, signal, (s) => this.#fetchUnverifiedFrom(path, cap, s));
  }

  // Ref-counted in-flight de-duplication with correct shared-abort semantics:
  // one consumer aborting must not cancel a fetch another still awaits, and a
  // consumer that joins after the last one aborted must start a fresh fetch
  // rather than ride the now-aborted shared controller.
  async #dedup<T>(
    key: string,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let entry = this.#inflight.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      const created: Inflight = { controller, refs: 0, promise: Promise.resolve() };
      created.promise = run(controller.signal).finally(() => {
        if (this.#inflight.get(key) === created) this.#inflight.delete(key);
      });
      this.#inflight.set(key, created);
      entry = created;
    }

    entry.refs++;
    const shared = entry;
    const onAbort = () => {
      if (--shared.refs === 0) {
        if (this.#inflight.get(key) === shared) this.#inflight.delete(key);
        shared.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = (await shared.promise) as T;
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #fetchCheckedFrom(
    path: string,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const errors: unknown[] = [];
    for (const source of this.#sources) {
      if (this.#banned.has(source)) continue;
      try {
        const bytes = await source.fetchWhole(path, cap, { signal });
        await check(bytes);
        this.stats.verified++;
        this.#cachePut(cacheKey, bytes);
        return bytes;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof VerificationError) {
          this.stats.rejected++;
          this.#banned.add(source);
        }
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for ${path}`);
  }

  async #fetchRunFrom(
    path: string,
    leaves: Leaf[],
    start: number,
    total: number,
    signal: AbortSignal,
  ): Promise<Uint8Array[]> {
    const errors: unknown[] = [];
    for (const source of this.#sources) {
      if (this.#banned.has(source)) continue;
      try {
        const body = await source.fetchRange(path, start, total, { signal });
        // Ranged lengths are known from the proofs; enforce before hashing.
        if (body.length !== total) {
          throw new VerificationError(`${path}: got ${body.length} bytes, expected ${total}`);
        }
        const slices = leaves.map((leaf) => {
          const from = leaf.offset - start;
          return body.slice(from, from + leaf.length); // copy: no shared-buffer retention
        });
        for (let i = 0; i < leaves.length; i++) {
          await verifyDigest(leaves[i]!.digest, slices[i]!, `${path}@${leaves[i]!.offset}`);
        }
        for (let i = 0; i < leaves.length; i++) {
          this.stats.verified++;
          this.#cachePut(leaves[i]!.digest, slices[i]!);
        }
        return slices;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof VerificationError) {
          this.stats.rejected++;
          this.#banned.add(source);
        }
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for run on ${path}`);
  }

  async #fetchUnverifiedFrom(path: string, cap: number, signal: AbortSignal): Promise<Uint8Array> {
    const errors: unknown[] = [];
    for (const source of this.#sources) {
      if (this.#banned.has(source)) continue;
      try {
        return await source.fetchWhole(path, cap, { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for ${path}`);
  }

  #cachePut(key: string, bytes: Uint8Array): void {
    if (this.#cache.has(key)) return;
    this.#cache.set(key, bytes);
    this.#cacheBytes += bytes.length;
    for (const [k, v] of this.#cache) {
      if (this.#cacheBytes <= this.#maxCacheBytes) break;
      this.#cache.delete(k);
      this.#cacheBytes -= v.length;
    }
  }
}
