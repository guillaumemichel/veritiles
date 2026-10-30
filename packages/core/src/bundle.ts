// A MASL bundle by its manifest's dag-cbor CID (SPEC §3.2), served from
// ordinary HTTP hosts: files by path, each verified against the manifest
// that its proof, a CAR or the bare manifest block, carries. Construction is
// synchronous and validates the anchor and configured locations; every
// location comes from the router (SPEC §6; the built-in one follows the
// page's configuration, and its hints documents once the page turns hints
// on, SPEC §5), asked for a CID only when a read first needs it. Every byte,
// wherever it was located, verifies against the anchor.

import { abortable } from './abortable.ts';
import { type Cid, cidToText, parseBundleAnchor } from './cid.ts';
import { DefaultRouter, type Hints } from './default-router.ts';
import { HttpSource } from './http-source.ts';
import { DEFAULT_MAX_CACHE_BYTES, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_PROOF_BYTES } from './limits.ts';
import { Locator } from './locations.ts';
import { pathKey, splitPath, type ManifestEntry } from './manifest.ts';
import { ProofSource } from './proof-source.ts';
import type { Router, RouterOption } from '@anymirror/router';
import { type FetchFn, toRouter } from './routing.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';
import { toHex, verifyDigest, VerificationError } from './verify.ts';

export interface VerifiedBundleOptions {
  /** The bundle's anchor: the dag-cbor CID of its MASL manifest. */
  cid: string;
  /** Base URL(s) of the bundle, tried in order. Optional: hints or a router may supply them. */
  source?: string | string[];
  /** Proof location(s): the manifest's CAR or block. Default `{base}.car` per base. */
  proof?: string | string[];
  /** Hints documents and discovery, untrusted (SPEC §5): `hints()` turns them on. Off by default. */
  hints?: Hints;
  /** Router, untrusted (SPEC §6): replaces the built-in one, which it gets as `defaults`, and may carry every request. */
  router?: RouterOption;
  /** Replaces global fetch — instrumentation, credentials, test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte cache of the bundle's files (default 64 MiB). */
  maxCacheBytes?: number;
  /** Bound on a proof body (default 32 MiB). */
  maxProofBytes?: number;
  /** Bound on one file (default 64 MiB). */
  maxFileBytes?: number;
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export interface AssetStat {
  size: number;
  contentType?: string;
}

export class VerifiedBundle {
  #cid: string;
  #anchor: Cid;
  #anchorText: string;
  #router: Router | undefined;
  #locator: Locator;
  #fetch: FetchFn;
  #maxProofBytes: number;
  #maxFileBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #proofs: ProofSource | undefined;
  // The bundle's files: one store reading each at its src CID's locations,
  // with one cache budget for them all.
  #files: VerifiedStore;

  constructor(options: VerifiedBundleOptions) {
    const { cid, source, proof, hints, router, fetchFn, maxCacheBytes, maxProofBytes, maxFileBytes } = options;
    this.#anchor = parseBundleAnchor(cid);
    this.#cid = cid;
    this.#anchorText = cidToText(this.#anchor);
    this.#maxProofBytes = maxProofBytes ?? DEFAULT_MAX_PROOF_BYTES;
    this.#maxFileBytes = maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    this.#router = toRouter(router);
    const bases = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (!bases.length || bases.some((base) => typeof base !== 'string' || !base.length))) {
      throw new Error('source must be a base URL or a non-empty list of base URLs');
    }
    const sources = bases.map((base) => base.replace(/\/+$/, ''));
    const defaults = new DefaultRouter({ anchor: this.#anchorText, kind: 'bundle', sources, proof, hints, fetchFn: this.#fetch });
    this.#locator = new Locator(this.#router, defaults);
    this.#files = new VerifiedStore(
      { sourceFor: (location, src) => this.#source(location, src) },
      { maxCacheBytes: maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES, stats: this.#stats },
    );
  }

  get cid(): string {
    return this.#cid;
  }

  get stats(): VerifyStats {
    return this.#stats;
  }

  // A file's verified bytes by its path in the bundle, a fresh copy each
  // read. A raw section the proof CAR carries serves without a request.
  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const segments = splitPath(path);
    const proofs = this.#proofSource();
    const entry = await this.#entry(proofs, segments, signal);
    if (entry.size > this.#maxFileBytes) throw new VerificationError('file exceeds maxFileBytes');
    const digest = toHex(entry.src.digest);
    const candidate = proofs.leafCandidate(digest);
    if (candidate !== undefined) {
      if (candidate.length === entry.size) {
        try {
          await verifyDigest(digest, candidate, 'manifest: raw section');
          this.#stats.verified++;
          return candidate.slice();
        } catch (err) {
          if (!(err instanceof VerificationError)) throw err;
        }
      }
      proofs.discardLeafCandidate(digest);
    }
    const locations = this.#locator.for(cidToText(entry.src), { kind: 'content', path: segments.join('/') });
    return (await this.#files.fetchCheckedFrom(locations, digest, entry.size, (bytes) => verifyDigest(digest, bytes, 'bundle content'), { signal })).slice();
  }

  // A file's size and content type, as the manifest declares them.
  async stat(path = ''): Promise<AssetStat> {
    const { size, contentType } = await this.#entry(this.#proofSource(), splitPath(path));
    return contentType === undefined ? { size } : { size, contentType };
  }

  // An abort stops this read waiting for the manifest, which goes on for the others.
  async #entry(proofs: ProofSource, segments: string[], signal?: AbortSignal): Promise<ManifestEntry> {
    const entry = (await abortable(proofs.root(this.#anchor), signal)).entries.get(pathKey(segments));
    if (entry === undefined) throw new NotFoundError(`not found: ${pathKey(segments)}`);
    return entry;
  }

  // The bundle's proof: the manifest block or a CAR holding it, at the
  // anchor's locations. Demotions and the verified root persist for the
  // client's lifetime.
  #proofSource(): ProofSource {
    this.#proofs ??= new ProofSource(this.#locator.for(this.#anchorText, { kind: 'proof', label: this.#cid }), {
      sourceFor: (location) => this.#source(location, this.#anchorText),
      maxProofBytes: this.#maxProofBytes,
      stats: this.#stats,
    });
    return this.#proofs;
  }

  #source(location: string, cid: string): HttpSource {
    return new HttpSource(location, { fetchFn: this.#fetch, route: { router: this.#router, cid, location } });
  }
}
