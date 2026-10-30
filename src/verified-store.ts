// The one verification choke point over a CID's locations: a digest-keyed
// LRU cache, in-flight de-duplication, strict verification, verified/rejected
// stats, a verdict on every response, and failover (SPEC §4): a location that
// serves wrong bytes is banned, one that fails in transport is demoted until
// it serves again. It reads whole files; a ranged file's store reads byte
// runs on top of it.

import { failover } from './failover.ts';
import type { Locations } from './locations.ts';
import { type Body, verdictOf } from './verdict.ts';
import { VerificationError, verifyDigest } from './verify.ts';

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export interface ByteSource {
  fetchWhole(path: string, cap: number, opts?: { signal?: AbortSignal }): Promise<Body>;
}

export interface VerifyStats {
  verified: number;
  rejected: number;
}

// Where a store's bytes come from: its CID's locations, and the byte source
// for a location of a CID (made once per pair). A store reading per-call
// locations (a bundle's files) has none of its own.
interface StoreSources<S> {
  locations?: Locations;
  sourceFor(location: string, cid: string): S;
}

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
}

export class VerifiedStore<S extends ByteSource = ByteSource> {
  #locations: Locations | undefined;
  #sourceFor: (location: string, cid: string) => S;
  #sources = new Map<string, S>();
  #cache = new Map<string, Uint8Array>(); // cache key -> bytes, insertion order = LRU
  #cacheBytes = 0;
  #maxCacheBytes: number;
  #inflight = new Map<string, Inflight>();
  stats: VerifyStats = { verified: 0, rejected: 0 };

  constructor(
    { locations, sourceFor }: StoreSources<S>,
    { maxCacheBytes = DEFAULT_CACHE_BYTES, stats }: { maxCacheBytes?: number; stats?: VerifyStats } = {},
  ) {
    this.#locations = locations;
    this.#sourceFor = sourceFor;
    this.#maxCacheBytes = maxCacheBytes;
    if (stats !== undefined) this.stats = stats;
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
  // fixed digest compare. Plain GET, cache, in-flight dedup, failover,
  // stats, and bans.
  async fetchChecked(
    path: string,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<number | void>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    return this.#checked(this.own(), path, cacheKey, cap, check, signal);
  }

  // The same for a file with locations of its own (a bundle file, by its src
  // CID), each serving the whole file.
  async fetchCheckedFrom(
    locations: Locations,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<number | void>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    return this.#checked(locations, '', cacheKey, cap, check, signal);
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

  // Ref-counted in-flight de-duplication with correct shared-abort semantics:
  // one consumer aborting must not cancel a fetch another still awaits, and a
  // consumer that joins after the last one aborted must start a fresh fetch
  // rather than ride the now-aborted shared controller. The entry is in the
  // map by the time this returns its promise.
  protected async dedup<T>(
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

  // The fetch in flight under a key, as an identity: what its readers share
  // can be kept beside it.
  protected inflight(key: string): object | undefined {
    return this.#inflight.get(key);
  }

  // A response whose handling failed: its verdict, and a rejection counted.
  // A failed request has no body here; its source judged it already.
  protected judged(body: Body | undefined, err: unknown, signal: AbortSignal): unknown {
    body?.settle(verdictOf(err, signal));
    if (err instanceof VerificationError && !signal.aborted) this.stats.rejected++;
    return err;
  }

  protected own(): Locations {
    if (this.#locations === undefined) throw new Error('this store reads per-call locations');
    return this.#locations;
  }

  protected source(location: string, cid: string): S {
    const key = `${cid} ${location}`;
    let source = this.#sources.get(key);
    if (source === undefined) {
      source = this.#sourceFor(location, cid);
      this.#sources.set(key, source);
    }
    return source;
  }

  // Keep verified bytes, evicting the least recently used beyond the budget.
  protected cachePut(key: string, bytes: Uint8Array): void {
    if (this.#cache.has(key)) return;
    this.#cache.set(key, bytes);
    this.#cacheBytes += bytes.length;
    for (const [k, v] of this.#cache) {
      if (this.#cacheBytes <= this.#maxCacheBytes) break;
      this.#cache.delete(k);
      this.#cacheBytes -= v.length;
    }
  }

  async #checked(
    locations: Locations,
    path: string,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<number | void>,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const cached = this.getCached(cacheKey);
    if (cached !== undefined) return cached;
    return this.dedup(`whole:${cacheKey}`, signal, (s) =>
      failover(locations, (location) => this.#whole(locations, location, path, cacheKey, cap, check, s), { signal: s }),
    );
  }

  async #whole(
    locations: Locations,
    location: string,
    path: string,
    cacheKey: string,
    cap: number,
    check: (bytes: Uint8Array) => Promise<number | void>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    let body: Body | undefined;
    try {
      body = await this.source(location, locations.cid).fetchWhole(path, cap, { signal });
      this.stats.verified += (await check(body.bytes)) ?? 1;
      body.settle('verified');
      this.cachePut(cacheKey, body.bytes);
      return body.bytes;
    } catch (err) {
      throw this.judged(body, err, signal);
    }
  }
}
