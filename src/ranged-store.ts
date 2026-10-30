// A ranged file's store: the verified store's cache, de-duplication, stats,
// verdicts and failover, reading byte runs of one file. A run of
// file-contiguous leaves is one Range request, verified leaf by leaf; the
// speculative half of a read is a body fetched UNVERIFIED while the proof
// descent is still in flight, then adopted leaf by leaf once the digests
// arrive, or discarded.

import { failover } from './failover.ts';
import type { Locations } from './locations.ts';
import type { Leaf } from './ranged-reader.ts';
import { type Body, Tally } from './verdict.ts';
import { type ByteSource, VerifiedStore } from './verified-store.ts';
import { VerificationError, verifyDigest } from './verify.ts';

export interface RangedByteSource extends ByteSource {
  fetchRange(
    path: string,
    start: number,
    length: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Body>;
}

export class RangedStore extends VerifiedStore<RangedByteSource> {
  // The readers of each speculative body in flight, by its fetch.
  #tallies = new WeakMap<object, Tally>();

  // Verified slices for a run of file-contiguous leaves, aligned with
  // `leaves`. One Range request per run; every slice is verified before any
  // is cached, so one bad leaf sends the whole run to the next location
  // instead of poisoning the cache. Concurrent identical runs share one
  // fetch + one verification pass.
  async fetchRun(path: string, leaves: Leaf[], { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array[]> {
    signal?.throwIfAborted();
    const locations = this.own();
    const start = leaves[0]!.offset;
    const total = leaves.reduce((n, l) => n + l.length, 0);
    return this.dedup(`run:${path}:${start}+${total}`, signal, (s) =>
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
    const locations = this.own();
    const key = `spec:${path}:${start}+${length}`;
    const joined = this.inflight(key);
    const tally = (joined && this.#tallies.get(joined)) ?? new Tally();
    const bytes = this.dedup(key, signal, async (s) => {
      const body = await failover(
        locations,
        (location) => this.source(location, locations.cid).fetchRange(path, start, length, { signal: s }),
        { signal: s, fresh: false, rejected: 'demote' },
      );
      tally.bind(body.settle);
      return body.bytes;
    });
    this.#tallies.set(this.inflight(key)!, tally); // the fetch this call opened or joined
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
        this.cachePut(leaves[i]!.digest, slices[i]!);
      }
      return slices;
    } catch (err) {
      if (err instanceof VerificationError) this.stats.rejected++;
      throw err;
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
      body = await this.source(location, locations.cid).fetchRange(path, start, total, { signal });
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
        this.cachePut(leaves[i]!.digest, slices[i]!);
      }
      return slices;
    } catch (err) {
      throw this.judged(body, err, signal);
    }
  }
}
