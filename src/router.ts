// Routers (SPEC §6): a router says where a CID's bytes may live. veritiles
// reads every location through one: the built-in router follows the page's
// configuration and hints documents (SPEC §5); a custom router replaces it,
// gets those locations as `defaults`, and may carry the requests too, told
// what veritiles made of each answer. A router is outside the root of trust:
// every byte fetched from a location it names verifies against the anchor.

import type { FetchFn } from './range-source.ts';

/** What veritiles made of one response from a location. */
export type Verdict = 'verified' | 'rejected' | 'failed' | 'unused';

export interface FetchContext {
  /** The CID the request reads: the anchor for proof files and a raw file, the map for its ranges, the src for a bundle file. */
  cid: string;
  /** The location the request goes to, as the router yielded it. */
  location: string;
  /** Settles once veritiles has judged the response, or dropped it. */
  verdict: Promise<Verdict>;
  /** The client's own fetch: its `fetchFn`, else the global one. */
  next(url: string, init: RequestInit): Promise<Response>;
}

export interface Router {
  /**
   * Where a CID's bytes may live, best first: URLs of the CID's bytes (for a
   * ranged file's anchor, `{proof}/root`). Read lazily: veritiles takes the
   * next location only when it needs another. `defaults` are the locations
   * the page itself names: configured, hinted, probed.
   */
  locate(
    cid: string,
    context: { defaults: AsyncIterable<string> },
  ): AsyncIterable<string> | Iterable<string> | Promise<Iterable<string>>;
  /** Carries every request to a location, answering as fetch would. */
  fetch?(url: string, init: RequestInit, context: FetchContext): Promise<Response>;
}

/** A router, or its `locate` alone. */
export type RouterOption = Router | Router['locate'];

export function toRouter(router: unknown): Router | undefined {
  if (router === undefined) return undefined;
  if (typeof router === 'function') return { locate: router as Router['locate'] };
  const { locate, fetch } = (router ?? {}) as Partial<Router>;
  if (typeof locate !== 'function' || (fetch !== undefined && typeof fetch !== 'function')) {
    throw new Error('router must be a function or an object with a locate method');
  }
  return router as Router;
}

// Who a request is for: the router that may carry it, the CID it reads, and
// the location it goes to as the router yielded it.
export interface Route {
  router: Router | undefined;
  cid: string;
  location: string;
}

// One request, sent synchronously, and the hook that reports its verdict.
// Without a router fetch the client's fetch carries it and nobody listens.
export function send(
  route: Route | undefined,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): { response: Promise<Response>; settle(verdict: Verdict): void } {
  const router = route?.router;
  if (route === undefined || router?.fetch === undefined) return { response: fetchFn(url, init), settle: () => {} };
  let settle!: (verdict: Verdict) => void;
  const verdict = new Promise<Verdict>((resolve) => {
    settle = resolve;
  });
  const context = { cid: route.cid, location: route.location, verdict, next: (u: string, i: RequestInit) => fetchFn(u, i) };
  try {
    return { response: Promise.resolve(router.fetch(url, init, context)), settle };
  } catch (err) {
    return { response: Promise.reject(err), settle };
  }
}
