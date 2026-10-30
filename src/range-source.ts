// Byte source for one base URL of a published package — a dumb static host
// or an /ipfs/<rootCID>/ path on any range-capable HTTP gateway; the client
// cannot tell the difference. Two request shapes only: a plain GET for
// whole small files (assets and proofs — CORS simple requests in every
// browser) and a single-`Range` GET for map byte runs. Returns UNVERIFIED
// bytes; the VerifiedStore above is the one verification choke point. A
// request a router carries goes through its fetch (SPEC §6), and a request
// that fails reports its own verdict.

import { readBody } from './read-body.ts';
import { type FetchFn, type Route, send } from './routing.ts';
import { encodePath } from './url.ts';
import { type Body, verdictOf } from './verdict.ts';

// A ranged GET the host answered with 200 (whole file) instead of 206: it
// ignores Range, so a per-tile read would drag the entire archive.
export class RangeUnsupportedError extends Error {
  override name = 'RangeUnsupportedError';
}

// A ranged GET rejected with a network TypeError even though a plain GET to
// same base already succeeded (a plain GET has succeeded) — the
// signature of a CORS preflight the host cannot answer (Firefox + a host
// that cannot allow `Range`).
export class RangeBlockedError extends Error {
  override name = 'RangeBlockedError';
}

export class RangeSource {
  #base: string;
  #fetchFn: FetchFn;
  #route: Route | undefined;
  #plainGetOk = false;

  constructor(base: string, { fetchFn, route }: { fetchFn?: FetchFn; route?: Route } = {}) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetchFn = fetchFn ?? ((...args: Parameters<FetchFn>) => fetch(...args));
    this.#route = route;
  }

  // Whole file by a validated bundle path; body read with a hard cap.
  async fetchWhole(path: string, cap: number, { signal }: { signal?: AbortSignal } = {}): Promise<Body> {
    const body = await this.#fetch(this.#url(path), { signal }, cap, true);
    this.#plainGetOk = true;
    return body;
  }

  // One contiguous byte range of a published file. Demands 206: a 200 means
  // the host ignored Range and would stream the whole archive per tile.
  async fetchRange(
    path: string,
    start: number,
    length: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Body> {
    const init = { signal, headers: { Range: `bytes=${start}-${start + length - 1}` } };
    return this.#fetch(this.#url(path), init, length, false);
  }

  // A file artifact's bytes live at `{base}` itself (SPEC §3); a member lives at
  // `{base}/{path}`. The empty path must not append a trailing slash. The map
  // path never fetches '', so it is unaffected.
  #url(path: string): string {
    return path === '' ? this.#base : `${this.#base}/${encodePath(path)}`;
  }

  // One request and its body, which is the caller's to judge. A failure is
  // judged here: unused if the caller aborted, rejected if the body broke its
  // cap or never came, else failed.
  async #fetch(url: string, init: RequestInit, cap: number, plainGet: boolean): Promise<Body> {
    const { response, settle } = send(this.#route, this.#fetchFn, url, init);
    try {
      const res = await this.#answer(url, response, plainGet);
      return { bytes: await readBody(res, cap), settle };
    } catch (err) {
      settle(verdictOf(err, init.signal ?? undefined));
      throw err;
    }
  }

  async #answer(url: string, response: Promise<Response>, plainGet: boolean): Promise<Response> {
    let res: Response;
    try {
      res = await response;
    } catch (err) {
      if (!plainGet && this.#plainGetOk && err instanceof TypeError) {
        throw new RangeBlockedError(
          `${url}: host refuses cross-origin range requests in this browser`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      void res.body?.cancel?.();
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    if (!plainGet && res.status !== 206) {
      void res.body?.cancel?.();
      throw new RangeUnsupportedError(
        `${url}: host ignored Range (status ${res.status}, wanted 206)`,
      );
    }
    return res;
  }
}
