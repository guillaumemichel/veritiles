// Verified reads over one file, given a LeafIndex that maps byte ranges to the
// leaves covering them. Warm path: the leaf lookup is answered synchronously
// from cached nodes, cache hits are copied, and the rest is fetched in maximal
// file-contiguous runs, one Range request each. Cold path: the exact requested
// range is fetched SPECULATIVELY in parallel with the lookup's shard requests
// — leaf-aligned reads adopt the speculative body as-is once digests arrive,
// collapsing a region's first read from two round trips to one. A misaligned
// or tampered speculative body is discarded and the ordinary verified run
// fetch takes over; integrity never depends on the speculation. Once every run
// that could use it is done, the read reports what it made of the body.
//
// This is the content-agnostic read loop: it knows nothing about PMTiles, the
// proof format, or the DAG — only the LeafIndex seam and the RangedStore.

import type { RangedStore } from './ranged-store.ts';
import type { Verdict } from './router.ts';
import { VerificationError } from './verify.ts';

// A verified byte range of the file and the digest its bytes must hash to.
export interface Leaf {
  offset: number;
  length: number;
  digest: string;
}

// The seam the read loop depends on: covering leaves for a byte range, async
// (may fetch/verify proof structure) or synchronous (cached only, else null).
// The async lookup calls `onShardsRequested` once the last proof request it
// needs is out.
export interface LeafIndex {
  leavesFor(
    start: number,
    end: number,
    opts?: { signal?: AbortSignal; onShardsRequested?: () => void },
  ): Promise<Leaf[]>;
  cachedLeavesFor(start: number, end: number): Leaf[] | null;
}

interface Run {
  leaves: Leaf[];
  end: number;
}

interface Speculation {
  body: Promise<Uint8Array | null>;
  cancel: () => void;
  // What a run made of the body: rejected outranks verified.
  judge: (verdict: 'verified' | 'rejected') => void;
  // Report the outcome once `runs` have settled.
  report: (runs: Promise<unknown>[]) => void;
}

export class RangedReader {
  #store: RangedStore;
  #proofs: LeafIndex;
  #path: string;
  #size: number;

  constructor(store: RangedStore, proofs: LeafIndex, path: string, size: number) {
    this.#store = store;
    this.#proofs = proofs;
    this.#path = path;
    this.#size = size;
  }

  get size(): number {
    return this.#size;
  }

  // Assembled, verified bytes for [offset, offset + length), clamped to EOF.
  async read(offset: number, length: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.#size);
    if (offset < 0 || offset >= end) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);

    let leaves = this.#proofs.cachedLeavesFor(offset, end);
    let spec = null as Speculation | null; // set in a callback: the cast stops TS narrowing it to null
    if (leaves === null) {
      // Speculate only once the shard requests are out: a shard queued behind
      // speculative content bytes delays every read it covers, and content
      // cannot verify before its shard anyway, so waiting costs no latency.
      const onShardsRequested = () => {
        spec = this.#speculate(offset, end - offset, signal);
      };
      try {
        leaves = await this.#proofs.leavesFor(offset, end, { signal, onShardsRequested });
      } catch (err) {
        spec?.cancel();
        spec?.report([]);
        throw err;
      }
    }

    const runs: Run[] = [];
    let run: Run | null = null;
    for (const leaf of leaves) {
      const cached = this.#store.getCached(leaf.digest);
      if (cached !== undefined) {
        copyOverlap(cached, leaf.offset, offset, end, out);
        run = null;
        continue;
      }
      if (run && leaf.offset === run.end) {
        run.leaves.push(leaf);
        run.end += leaf.length;
      } else {
        run = { leaves: [leaf], end: leaf.offset + leaf.length };
        runs.push(run);
      }
    }

    // A run is adoptable when it lies entirely inside the speculative body
    // — for leaf-aligned reads that is the whole (single) run.
    const adoptable = (r: Run) => spec !== null && r.leaves[0]!.offset >= offset && r.end <= end;
    if (spec !== null && !runs.some(adoptable)) spec.cancel();

    const reads = runs.map(async (r) => {
      let slices: Uint8Array[] | null = null;
      if (adoptable(r)) {
        const body = await spec!.body;
        if (body !== null) {
          try {
            slices = await this.#store.adoptSlices(r.leaves, body, offset, { signal });
            spec!.judge('verified');
          } catch (err) {
            if (!(err instanceof VerificationError)) throw err;
            spec!.judge('rejected'); // bad speculation: fall through to a verified fetch
          }
        }
      }
      slices ??= await this.#store.fetchRun(this.#path, r.leaves, { signal });
      r.leaves.forEach((leaf, i) => copyOverlap(slices[i]!, leaf.offset, offset, end, out));
    });
    spec?.report(reads);
    await Promise.all(reads);
    return out;
  }

  // Fire the unverified parallel fetch of exactly the requested range, with
  // its own cancel handle; failures resolve to null so the verified
  // fallback path decides, never the speculation.
  #speculate(offset: number, length: number, signal: AbortSignal | undefined): Speculation {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const speculative = this.#store
      .fetchRangeUnverified(this.#path, offset, length, { signal: merged })
      .catch(() => null);
    let outcome: Verdict = 'unused';
    return {
      body: speculative.then((s) => s?.bytes ?? null),
      cancel: () => controller.abort(),
      judge: (verdict) => {
        if (verdict === 'rejected' || outcome === 'unused') outcome = verdict;
      },
      report: (runs) => void Promise.allSettled(runs).then(() => speculative).then((s) => s?.settle(outcome)),
    };
  }
}

function copyOverlap(
  bytes: Uint8Array,
  base: number,
  start: number,
  end: number,
  out: Uint8Array,
): void {
  const from = Math.max(start, base);
  const to = Math.min(end, base + bytes.length);
  if (from >= to) return;
  out.set(bytes.subarray(from - base, to - base), from - start);
}
