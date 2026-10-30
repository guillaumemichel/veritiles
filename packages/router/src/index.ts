// Routers (SPEC §6): a router says where a CID's bytes may live. A client
// reads every location through one: the built-in router follows the page's
// configuration and, with hints on, hints documents (SPEC §5); a custom router
// replaces it, gets those locations as `defaults`, and may carry the requests
// too, told what the client made of each answer. A router is outside the root
// of trust: every byte fetched from a location it names verifies against the
// anchor. This package is the contract alone: types, no code.

/** What the client made of one response from a location. */
export type Verdict = 'verified' | 'rejected' | 'failed' | 'unused';

export interface FetchContext {
  /** The CID the request reads: the anchor for proof files and a raw file, the map for its ranges, the src for a bundle file. */
  cid: string;
  /** The location the request goes to, as the router yielded it. */
  location: string;
  /** Settles once the client has judged the response, or dropped it. */
  verdict: Promise<Verdict>;
  /** The client's own fetch: its `fetchFn`, else the global one. */
  next(url: string, init: RequestInit): Promise<Response>;
}

export interface Router {
  /**
   * Where a CID's bytes may live, best first: URLs of the CID's bytes (for a
   * ranged file's anchor, `{proof}/root`). Read lazily: the client takes the
   * next location only when it needs another. `defaults` are the locations
   * the page itself names: configured, then, with hints on, hinted and
   * probed.
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
