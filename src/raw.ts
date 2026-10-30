// A raw file by its raw CID (SPEC §3.1), read whole from ordinary HTTP
// hosts: at most 256 KiB, its bytes hashed against the anchor. Construction
// is synchronous and validates the anchor and configured locations; every
// location comes from the router (SPEC §6; the built-in one follows the
// page's configuration, and its hints documents once the page turns hints
// on, SPEC §5), asked only when the first read needs one.

import { cidToText, parseRawAnchor } from './cid.ts';
import { DefaultRouter, type Hints } from './default-router.ts';
import { HttpSource } from './http-source.ts';
import { ASSET_WHOLE_CAP, DEFAULT_MAX_CACHE_BYTES } from './limits.ts';
import { Locator } from './locations.ts';
import type { Router, RouterOption } from './router.ts';
import { type FetchFn, toRouter } from './routing.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';
import { toHex } from './verify.ts';

export interface VerifiedRawOptions {
  /** The file's raw CID: the sha2-256 of its bytes. */
  cid: string;
  /** URL(s) of the file, tried in order. Optional: hints or a router may supply them. */
  source?: string | string[];
  /** Hints documents and discovery, untrusted (SPEC §5): `hints()` turns them on. Off by default. */
  hints?: Hints;
  /** Router, untrusted (SPEC §6): replaces the built-in one, which it gets as `defaults`, and may carry every request. */
  router?: RouterOption;
  /** Replaces global fetch — instrumentation, credentials, test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte cache (default 64 MiB). */
  maxCacheBytes?: number;
}

export class VerifiedRaw {
  #cid: string;
  #anchorText: string;
  #digest: string;
  #router: Router | undefined;
  #locator: Locator;
  #fetch: FetchFn;
  #maxCacheBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #store: VerifiedStore | undefined;

  constructor(options: VerifiedRawOptions) {
    const { cid, source, hints, router, fetchFn, maxCacheBytes } = options;
    const anchor = parseRawAnchor(cid);
    this.#cid = cid;
    this.#anchorText = cidToText(anchor);
    this.#digest = toHex(anchor.digest);
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    this.#maxCacheBytes = maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.#router = toRouter(router);
    const urls = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (!urls.length || urls.some((url) => typeof url !== 'string' || !url.length))) {
      throw new Error('source must be a URL or a non-empty list of URLs');
    }
    const sources = urls.map((url) => url.replace(/\/+$/, ''));
    const defaults = new DefaultRouter({ anchor: this.#anchorText, kind: 'raw', sources, proof: undefined, hints, fetchFn: this.#fetch });
    this.#locator = new Locator(this.#router, defaults);
  }

  get cid(): string {
    return this.#cid;
  }

  get stats(): VerifyStats {
    return this.#stats;
  }

  // The file's verified bytes, a fresh copy each read.
  async bytes({ signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    return (await this.#file().fetchWhole('', this.#digest, ASSET_WHOLE_CAP, { signal })).slice();
  }

  // The file at the anchor's own locations, asked for on the first read.
  #file(): VerifiedStore {
    this.#store ??= new VerifiedStore(
      { locations: this.#locator.for(this.#anchorText, { kind: 'content', label: this.#cid }), sourceFor: (location) => this.#source(location) },
      { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats },
    );
    return this.#store;
  }

  #source(location: string): HttpSource {
    return new HttpSource(location, { fetchFn: this.#fetch, route: { router: this.#router, cid: this.#anchorText, location } });
  }
}
