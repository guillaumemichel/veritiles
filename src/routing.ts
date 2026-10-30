// Router plumbing (SPEC §6): the page's router option made a router, and
// one request sent through the router that carries it, else through the
// client's own fetch.

import type { Router, Verdict } from './router.ts';

export type FetchFn = typeof fetch;

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
