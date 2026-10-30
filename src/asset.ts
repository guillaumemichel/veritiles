// Verified raw files and MASL bundles served from ordinary HTTP hosts.
// Construction is synchronous and validates the anchor and configured
// locations; every location comes from the router (SPEC §6; the built-in one
// follows the page's configuration and hints documents, SPEC §5), asked for a
// CID only when a read first needs it. Every byte, wherever it was located,
// verifies against the anchor.

import { abortable } from './abortable.ts';
import { type Cid, cidToText, DAG_CBOR_CODE, parseAssetAnchor } from './cid.ts';
import { DefaultRouter } from './default-router.ts';
import {
  ASSET_WHOLE_CAP,
  DEFAULT_MAX_CACHE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PROOF_BYTES,
} from './limits.ts';
import { Locator } from './locations.ts';
import { pathKey, splitPath, type ManifestEntry } from './manifest.ts';
import { ProofSource } from './proof-source.ts';
import { RangeSource } from './range-source.ts';
import type { Router, RouterOption } from './router.ts';
import { type FetchFn, toRouter } from './routing.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';
import { toHex, verifyDigest, VerificationError } from './verify.ts';

export interface VerifiedAssetOptions {
  /** Content anchor: raw for one file or dag-cbor for a MASL bundle. */
  cid: string;
  /** Base URL(s) of the artifact, tried in order. Optional: hints or a router may supply them. */
  source?: string | string[];
  proof?: string | string[];
  /** Routing-hints document URL(s), untrusted (SPEC §5); defaults to `./hints.json`. */
  hints?: string | string[];
  /** Router, untrusted (SPEC §6): replaces the built-in one, which it gets as `defaults`, and may carry every request. */
  router?: RouterOption;
  fetchFn?: FetchFn;
  maxCacheBytes?: number;
  maxProofBytes?: number;
  maxFileBytes?: number;
}

export class NotFoundError extends Error { override name = 'NotFoundError'; }
export interface AssetStat { size: number; contentType?: string; }

export class VerifiedAsset {
  #cid: string; #anchor: Cid; #anchorDigestHex: string; #anchorText: string; #kind: 'raw' | 'bundle';
  #router: Router | undefined; #locator: Locator;
  #fetch: FetchFn; #maxCacheBytes: number; #maxProofBytes: number; #maxFileBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #rawStore: VerifiedStore | undefined; #proofs: ProofSource | undefined;
  // A bundle's files: one store reading each at its src CID's locations, with
  // one cache budget for them all.
  #fileStore: VerifiedStore;

  constructor(options: VerifiedAssetOptions) {
    const { cid, source, proof, hints, router, fetchFn, maxCacheBytes, maxProofBytes, maxFileBytes } = options;
    this.#anchor = parseAssetAnchor(cid); this.#cid = cid; this.#anchorDigestHex = toHex(this.#anchor.digest); this.#anchorText = cidToText(this.#anchor);
    this.#kind = this.#anchor.codec === DAG_CBOR_CODE ? 'bundle' : 'raw';
    this.#maxCacheBytes = maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES; this.#maxProofBytes = maxProofBytes ?? DEFAULT_MAX_PROOF_BYTES; this.#maxFileBytes = maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args)); this.#router = toRouter(router);
    const bases = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (!bases.length || bases.some((base) => typeof base !== 'string' || !base.length))) throw new Error('source must be a base URL or a non-empty list of base URLs');
    if (this.#kind === 'raw' && proof !== undefined) throw new Error('proof is not valid for a raw anchor');
    const sources = bases.map((base) => base.replace(/\/+$/, ''));
    const defaults = new DefaultRouter({ anchor: this.#anchorText, kind: this.#kind, sources, proof, hints, fetchFn: this.#fetch });
    this.#locator = new Locator(this.#router, defaults);
    this.#fileStore = new VerifiedStore({ sourceFor: (location, srcText) => this.#source(location, srcText) }, { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats });
  }

  get cid(): string { return this.#cid; }
  get stats(): VerifyStats { return this.#stats; }

  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      return (await this.#rawFile().fetchWhole('', this.#anchorDigestHex, ASSET_WHOLE_CAP, { signal })).slice();
    }
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
    return (await this.#fileStore.fetchCheckedFrom(locations, digest, entry.size, (bytes) => verifyDigest(digest, bytes, 'bundle content'), { signal })).slice();
  }

  async stat(path = ''): Promise<AssetStat> {
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      throw new VerificationError('raw artifact has no declared size');
    }
    const { size, contentType } = await this.#entry(this.#proofSource(), segments);
    return contentType === undefined ? { size } : { size, contentType };
  }

  // An abort stops this read waiting for the manifest, which goes on for the others.
  async #entry(proofs: ProofSource, segments: string[], signal?: AbortSignal): Promise<ManifestEntry> {
    const entry = (await abortable(proofs.root(this.#anchor), signal)).entries.get(pathKey(segments));
    if (entry === undefined) throw new NotFoundError(`not found: ${pathKey(segments)}`);
    return entry;
  }

  // A raw anchor's file, at the anchor's own locations.
  #rawFile(): VerifiedStore {
    this.#rawStore ??= new VerifiedStore({ locations: this.#locator.for(this.#anchorText, { kind: 'content', label: this.#cid }), sourceFor: (location) => this.#source(location, this.#anchorText) }, { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats });
    return this.#rawStore;
  }

  // A bundle's proof: the manifest block or a CAR holding it, at the anchor's
  // locations. Demotions and the verified root persist for the client's lifetime.
  #proofSource(): ProofSource {
    this.#proofs ??= new ProofSource(this.#locator.for(this.#anchorText, { kind: 'proof', label: this.#cid }), { sourceFor: (location) => this.#source(location, this.#anchorText), maxProofBytes: this.#maxProofBytes, stats: this.#stats });
    return this.#proofs;
  }

  #source(location: string, cid: string): RangeSource {
    return new RangeSource(location, { fetchFn: this.#fetch, route: { router: this.#router, cid, location } });
  }
}
