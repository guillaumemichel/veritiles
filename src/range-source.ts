// Byte source for one base URL of a published package — a dumb static host
// or an /ipfs/<rootCID>/ path on any range-capable HTTP gateway; the client
// cannot tell the difference. Two request shapes only: a plain GET for
// whole small files (metadata.json, proofs — CORS simple requests in every
// browser) and a single-`Range` GET for map byte runs. Returns UNVERIFIED
// bytes; the VerifiedStore above is the one verification choke point.

import { readBody } from './read-body.ts';

export type FetchFn = typeof fetch;

// A ranged GET the host answered with 200 (whole file) instead of 206: it
// ignores Range, so a per-tile read would drag the entire archive.
export class RangeUnsupportedError extends Error {
  override name = 'RangeUnsupportedError';
}

// A ranged GET rejected with a network TypeError even though a plain GET to
// the same base already succeeded (metadata.json always has by then) — the
// signature of a CORS preflight the host cannot answer (Firefox + a host
// that cannot allow `Range`).
export class RangeBlockedError extends Error {
  override name = 'RangeBlockedError';
}

export class RangeSource {
  #base: string;
  #fetchFn: FetchFn;
  #plainGetOk = false;

  constructor(base: string, { fetchFn }: { fetchFn?: FetchFn } = {}) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetchFn = fetchFn ?? ((...args: Parameters<FetchFn>) => fetch(...args));
  }

  // Whole file by decoded UnixFS path; body read with a hard cap.
  async fetchWhole(path: string, cap: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const res = await this.#request(this.#url(path), { signal }, true);
    const body = await readBody(res, cap);
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
  ): Promise<Uint8Array> {
    const init = { signal, headers: { Range: `bytes=${start}-${start + length - 1}` } };
    const res = await this.#request(this.#url(path), init, false);
    return readBody(res, length);
  }

  #url(path: string): string {
    return `${this.#base}/${encodePath(path)}`;
  }

  async #request(url: string, init: RequestInit, plainGet: boolean): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetchFn(url, init);
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

// Percent-encode each path segment; the separators stay literal.
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
