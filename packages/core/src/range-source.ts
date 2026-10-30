// Byte ranges of a published file over HTTP: beside the plain GET of every
// source, a single-`Range` GET for map byte runs, the one other request
// shape. Returns UNVERIFIED bytes, like every source.

import { checkOk, HttpSource } from './http-source.ts';
import type { Body } from './verdict.ts';

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

export class RangeSource extends HttpSource {
  #plainGetOk = false;

  override async fetchWhole(path: string, cap: number, opts: { signal?: AbortSignal } = {}): Promise<Body> {
    const body = await super.fetchWhole(path, cap, opts);
    this.#plainGetOk = true;
    return body;
  }

  // One contiguous byte range of a published file. Demands 206: a 200 means
  // the host ignored Range and would stream the whole archive per tile.
  fetchRange(
    path: string,
    start: number,
    length: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Body> {
    const init = { signal, headers: { Range: `bytes=${start}-${start + length - 1}` } };
    return this.request(path, init, length, (url, response) => this.#answer(url, response));
  }

  async #answer(url: string, response: Promise<Response>): Promise<Response> {
    const res = await checkOk(url, response.catch((err: unknown) => {
      throw this.#plainGetOk && err instanceof TypeError
        ? new RangeBlockedError(`${url}: host refuses cross-origin range requests in this browser`)
        : err;
    }));
    if (res.status !== 206) {
      void res.body?.cancel?.();
      throw new RangeUnsupportedError(
        `${url}: host ignored Range (status ${res.status}, wanted 206)`,
      );
    }
    return res;
  }
}
