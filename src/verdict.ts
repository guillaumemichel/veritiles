// Verdicts (SPEC §6): what veritiles made of each response from a location,
// told to a router that carries the requests. Whoever ends a response's life
// reports it: the transport when the request fails, the verifying fetch when
// the bytes arrive, a client dropping a response it sent early, or the
// speculative readers together when they share one body.

import type { Verdict } from './router.ts';
import { VerificationError } from './verify.ts';

// An unverified response body and the hook that reports its fate; only the
// first report counts.
export interface Body {
  bytes: Uint8Array;
  settle(verdict: Verdict): void;
}

// The verdict on a response whose handling threw: rejected if its bytes
// failed a check, even as the caller aborted; else unused if the caller
// aborted, failed if not.
export function verdictOf(err: unknown, signal: AbortSignal | undefined): Verdict {
  if (err instanceof VerificationError) return 'rejected';
  return signal?.aborted ? 'unused' : 'failed';
}

const RANK: Record<Verdict, number> = { unused: 0, failed: 1, verified: 2, rejected: 3 };

// One response shared by several readers, each joining before it arrives and
// reporting once. It settles, once, when the body is bound and the last
// reader has reported: rejected if any reader rejected its bytes, else
// verified if any used them, else unused.
export class Tally {
  #waiting = 0;
  #verdict: Verdict = 'unused';
  #settle: ((verdict: Verdict) => void) | undefined;
  #settled = false;

  join(): (verdict: Verdict) => void {
    this.#waiting++;
    let reported = false;
    return (verdict) => {
      if (reported) return;
      reported = true;
      if (RANK[verdict] > RANK[this.#verdict]) this.#verdict = verdict;
      this.#waiting--;
      this.#flush();
    };
  }

  bind(settle: (verdict: Verdict) => void): void {
    this.#settle ??= settle;
    this.#flush();
  }

  #flush(): void {
    if (this.#settled || this.#waiting > 0 || this.#settle === undefined) return;
    this.#settled = true;
    this.#settle(this.#verdict);
  }
}
