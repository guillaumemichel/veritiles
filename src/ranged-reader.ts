// Verified reads over one file, given a LeafIndex that maps byte ranges to the
// leaves covering them. Warm path: the leaf lookup is answered synchronously
// from cached nodes, cache hits are copied, and the rest is fetched in maximal
// file-contiguous runs, one Range request each. Cold path: the exact requested
// range is fetched SPECULATIVELY in parallel with the (async) leaf lookup —
// leaf-aligned reads adopt the speculative body as-is once digests arrive,
// collapsing a region's first read from two round trips to one. A misaligned
// or tampered speculative body is discarded and the ordinary verified run
// fetch takes over; integrity never depends on the speculation.
//
// This is the content-agnostic read loop: it knows nothing about PMTiles, the
// proof format, or the DAG — only the LeafIndex seam and the VerifiedStore.

import type { VerifiedStore } from './verified-store.ts';
import { VerificationError } from './verify.ts';

// A verified byte range of the file and the digest its bytes must hash to.
export interface Leaf {
  offset: number;
  length: number;
  digest: string;
}

// The seam the read loop depends on: covering leaves for a byte range, async
// (may fetch/verify proof structure) or synchronous (cached only, else null).
export interface LeafIndex {
  leavesFor(start: number, end: number, opts?: { signal?: AbortSignal }): Promise<Leaf[]>;
  cachedLeavesFor(start: number, end: number): Leaf[] | null;
}

interface Run {
  leaves: Leaf[];
  end: number;
}

interface Speculation {
  body: Promise<Uint8Array | null>;
  cancel: () => void;
}

export class RangedReader {
  #store: VerifiedStore;
  #proofs: LeafIndex;
  #path: string;
  #size: number;

  constructor(store: VerifiedStore, proofs: LeafIndex, path: string, size: number) {
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
    let spec: Speculation | null = null;
    if (leaves === null) {
      spec = this.#speculate(offset, end - offset, signal);
      try {
        leaves = await this.#proofs.leavesFor(offset, end, { signal });
      } catch (err) {
        spec.cancel();
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

    await Promise.all(
      runs.map(async (r) => {
        let slices: Uint8Array[] | null = null;
        if (adoptable(r)) {
          const body = await spec!.body;
          if (body !== null) {
            try {
              slices = await this.#store.adoptSlices(r.leaves, body, offset, { signal });
            } catch (err) {
              if (!(err instanceof VerificationError)) throw err;
              slices = null; // bad speculation: fall through to a verified fetch
            }
          }
        }
        if (slices === null) slices = await this.#store.fetchRun(this.#path, r.leaves, { signal });
        r.leaves.forEach((leaf, i) => copyOverlap(slices[i]!, leaf.offset, offset, end, out));
      }),
    );
    return out;
  }

  // Fire the unverified parallel fetch of exactly the requested range, with
  // its own cancel handle; failures resolve to null so the verified
  // fallback path decides, never the speculation.
  #speculate(offset: number, length: number, signal: AbortSignal | undefined): Speculation {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const body = this.#store
      .fetchRangeUnverified(this.#path, offset, length, { signal: merged })
      .catch(() => null);
    return { body, cancel: () => controller.abort() };
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
