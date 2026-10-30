// Byte source for one base URL — a dumb static host or an /ipfs/<rootCID>/
// path on any HTTP gateway; the client cannot tell the difference. A plain
// GET reads a whole small file (an asset, a proof file), a CORS simple
// request in every browser. Returns UNVERIFIED bytes; the VerifiedStore
// above is the one verification choke point. A request a router carries
// goes through its fetch (SPEC §6), and a request that fails reports its
// own verdict.

import { readBody } from './read-body.ts';
import { type FetchFn, type Route, send } from './routing.ts';
import { encodePath } from './url.ts';
import { type Body, verdictOf } from './verdict.ts';

// Checks a response before its body is read.
export type Answer = (url: string, response: Promise<Response>) => Promise<Response>;

export class HttpSource {
  #base: string;
  #fetchFn: FetchFn;
  #route: Route | undefined;

  constructor(base: string, { fetchFn, route }: { fetchFn?: FetchFn; route?: Route } = {}) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetchFn = fetchFn ?? ((...args: Parameters<FetchFn>) => fetch(...args));
    this.#route = route;
  }

  // Whole file by a validated bundle path; body read with a hard cap.
  fetchWhole(path: string, cap: number, { signal }: { signal?: AbortSignal } = {}): Promise<Body> {
    return this.request(path, { signal }, cap, checkOk);
  }

  // One request and its body, which is the caller's to judge. A failure is
  // judged here: unused if the caller aborted, rejected if the body broke its
  // cap or never came, else failed.
  protected async request(path: string, init: RequestInit, cap: number, answer: Answer): Promise<Body> {
    const url = this.#url(path);
    const { response, settle } = send(this.#route, this.#fetchFn, url, init);
    try {
      const res = await answer(url, response);
      return { bytes: await readBody(res, cap), settle };
    } catch (err) {
      settle(verdictOf(err, init.signal ?? undefined));
      throw err;
    }
  }

  // A file artifact's bytes live at `{base}` itself (SPEC §3); a member lives at
  // `{base}/{path}`. The empty path must not append a trailing slash. The map
  // path never fetches '', so it is unaffected.
  #url(path: string): string {
    return path === '' ? this.#base : `${this.#base}/${encodePath(path)}`;
  }
}

// A plain GET's answer: any 2xx.
export async function checkOk(url: string, response: Promise<Response>): Promise<Response> {
  const res = await response;
  if (!res.ok) {
    void res.body?.cancel?.();
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res;
}
