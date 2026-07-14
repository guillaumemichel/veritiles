// Verified reads over the map archive. Warm path: the proof descent is
// answered synchronously from cached shards, cache hits are copied, and the
// rest is fetched in maximal file-contiguous runs, one Range request each.
// Cold path: the exact requested range is fetched SPECULATIVELY in parallel
// with the proof descent — tile reads are leaf-aligned by construction, so
// the body is almost always adoptable as-is once digests arrive, collapsing
// a region's first tile from two round trips to one. A misaligned or
// tampered speculative body is discarded and the ordinary verified run
// fetch takes over; integrity never depends on the speculation.

import type { Leaf } from './proof-format.ts';
import type { ProofIndex } from './proof-index.ts';
import type { VerifiedStore } from './verified-store.ts';
import { VerificationError } from './verify.ts';

interface Run {
  leaves: Leaf[];
  end: number;
}

interface Speculation {
  body: Promise<Uint8Array | null>;
  cancel: () => void;
}

export class MapFile {
  #store: VerifiedStore;
  #proofs: ProofIndex;
  #path: string;
  #size: number;

  constructor(store: VerifiedStore, proofs: ProofIndex, path: string, size: number) {
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
    // — for leaf-aligned tile reads that is the whole (single) run.
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
