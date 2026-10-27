// The one verification choke point over a CID's locations: a digest-keyed
// LRU cache, in-flight de-duplication, strict verification, verified/rejected
// stats, a verdict on every response, and failover (SPEC §4): a location that
// serves wrong bytes is banned, one that fails in transport is demoted until
// it serves again. Sources hand up unverified bytes only to the speculative
// range path, which authenticates them before caching or returning them.

import { failover } from './failover.ts';
import type { Locations } from './locations.ts';
import type { Leaf } from './ranged-reader.ts';
import { type Body, Tally, verdictOf } from './verdict.ts';
import { VerificationError, verifyDigest } from './verify.ts';

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export interface ByteSource {
  fetchWhole(path: string, cap: number, opts?: { signal?: AbortSignal }): Promise<Body>;
  fetchRange(
    path: string,
    start: number,
    length: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Body>;
}

export interface VerifyStats {
  verified: number;
  rejected: number;
}

// Where a store's bytes come from: its CID's locations, and the byte source
// for a location of a CID (made once per pair). A store reading per-call
// locations (a bundle's files) has none of its own.
interface StoreSources {
  locations?: Locations;
  sourceFor(location: string, cid: string): ByteSource;
}

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
  tally?: Tally; // a speculative body's readers
}

export class VerifiedStore {
  #locations: Locations | undefined;
  #sourceFor: (location: string, cid: string) => ByteSource;
  #sources = new Map<string, ByteSource>();
  #cache = new Map<string, Uint8Array>(); // cache key -> bytes, insertion order = LRU
  #cacheBytes = 0;
  #maxCacheBytes: number;
  #inflight = new Map<string, Inflight>();
  stats: VerifyStats = { verified: 0, rejected: 0 };

  constructor(
    { locations, sourceFor }: StoreSources,
    { maxCacheBytes = DEFAULT_CACHE_BYTES, stats }: { maxCacheBytes?: number; stats?: VerifyStats } = {},
  ) {
    this.#locations = locations;
    this.#sourceFor = sourceFor;
    this.#maxCacheBytes = maxCacheBytes;
    if (stats !== undefined) this.stats = stats;
  }

  // Insert already-verified bytes into the cache without re-hashing or
  // counting — for a block the caller verified elsewhere (e.g. a raw anchor's
  // single leaf, which IS the root block hashed at open).
  cacheVerified(key: string, bytes: Uint8Array): void {
    this.#cachePut(key, bytes);
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
    return this.#checked(this.#own(), path, cacheKey, cap, check, signal);
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

  // Verified slices for a run of file-contiguous leaves, aligned with
  // `leaves`. One Range request per run; every slice is verified before any
  // is cached, so one bad leaf sends the whole run to the next location
  // instead of poisoning the cache. Concurrent identical runs share one
  // fetch + one verification pass.
  async fetchRun(path: string, leaves: Leaf[], { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array[]> {
    signal?.throwIfAborted();
    const locations = this.#own();
    const start = leaves[0]!.offset;
    const total = leaves.reduce((n, l) => n + l.length, 0);
    return this.#dedup(`run:${path}:${start}+${total}`, signal, (s) =>
      failover(locations, (location) => this.#run(locations, location, path, leaves, start, total, s), { signal: s }),
    );
  }

  // UNVERIFIED ranged body — the speculative half of a parallel read: fetched
  // while the proof descent is still in flight, then adopted leaf-by-leaf via
  // adoptSlices once digests are known, or discarded. Never cached here: a
  // location that fails, an over-long body included, is only demoted, and
  // the verified fetch that follows judges. Tried at the locations held
  // already: speculation never asks the router for more. Readers sharing one
  // body each settle what they made of it.
  async fetchRangeUnverified(
    path: string,
    start: number,
    length: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Body> {
    signal?.throwIfAborted();
    const locations = this.#own();
    const key = `spec:${path}:${start}+${length}`;
    const tally = this.#inflight.get(key)?.tally ?? new Tally();
    const bytes = this.#dedup(key, signal, async (s) => {
      const body = await failover(
        locations,
        (location) => this.#source(location, locations.cid).fetchRange(path, start, length, { signal: s }),
        { signal: s, fresh: false, rejected: 'demote' },
      );
      tally.bind(body.settle);
      return body.bytes;
    });
    this.#inflight.get(key)!.tally = tally; // the entry this call opened or joined
    const settle = tally.join();
    try {
      return { bytes: await bytes, settle };
    } catch (err) {
      settle('unused');
      throw err;
    }
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

  // Ref-counted in-flight de-duplication with correct shared-abort semantics:
  // one consumer aborting must not cancel a fetch another still awaits, and a
  // consumer that joins after the last one aborted must start a fresh fetch
  // rather than ride the now-aborted shared controller. The entry is in the
  // map by the time this returns its promise.
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
    return this.#dedup(`whole:${cacheKey}`, signal, (s) =>
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
      body = await this.#source(location, locations.cid).fetchWhole(path, cap, { signal });
      this.stats.verified += (await check(body.bytes)) ?? 1;
      body.settle('verified');
      this.#cachePut(cacheKey, body.bytes);
      return body.bytes;
    } catch (err) {
      throw this.#judged(body, err, signal);
    }
  }

  async #run(
    locations: Locations,
    location: string,
    path: string,
    leaves: Leaf[],
    start: number,
    total: number,
    signal: AbortSignal,
  ): Promise<Uint8Array[]> {
    let body: Body | undefined;
    try {
      body = await this.#source(location, locations.cid).fetchRange(path, start, total, { signal });
      const { bytes } = body;
      // Ranged lengths are known from the proofs; enforce before hashing.
      if (bytes.length !== total) {
        throw new VerificationError(`${path}: got ${bytes.length} bytes, expected ${total}`);
      }
      const slices = leaves.map((leaf) => {
        const from = leaf.offset - start;
        return bytes.slice(from, from + leaf.length); // copy: no shared-buffer retention
      });
      for (let i = 0; i < leaves.length; i++) {
        await verifyDigest(leaves[i]!.digest, slices[i]!, `${path}@${leaves[i]!.offset}`);
      }
      body.settle('verified');
      for (let i = 0; i < leaves.length; i++) {
        this.stats.verified++;
        this.#cachePut(leaves[i]!.digest, slices[i]!);
      }
      return slices;
    } catch (err) {
      throw this.#judged(body, err, signal);
    }
  }

  // A response whose handling failed: its verdict, and a rejection counted.
  // A failed request has no body here; its source judged it already.
  #judged(body: Body | undefined, err: unknown, signal: AbortSignal): unknown {
    body?.settle(verdictOf(err, signal));
    if (err instanceof VerificationError && !signal.aborted) this.stats.rejected++;
    return err;
  }

  #own(): Locations {
    if (this.#locations === undefined) throw new Error('this store reads per-call locations');
    return this.#locations;
  }

  #source(location: string, cid: string): ByteSource {
    const key = `${cid} ${location}`;
    let source = this.#sources.get(key);
    if (source === undefined) {
      source = this.#sourceFor(location, cid);
      this.#sources.set(key, source);
    }
    return source;
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
