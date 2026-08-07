// Verified raw files and MASL bundles served from ordinary HTTP hosts.

import { type Cid, DAG_CBOR_CODE, parseAssetAnchor } from './cid.ts';
import { ASSET_WHOLE_CAP, DEFAULT_MAX_CACHE_BYTES, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_PROOF_BYTES } from './limits.ts';
import { pathKey, splitPath, type ManifestEntry } from './manifest.ts';
import { ProofSource } from './proof-source.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';
import { toHex, verifyDigest, VerificationError } from './verify.ts';

export interface VerifiedAssetOptions {
  /** Content anchor: raw for one file or dag-cbor for a MASL bundle. */
  cid: string;
  source: string | string[];
  proof?: string | string[];
  fetchFn?: FetchFn;
  maxCacheBytes?: number;
  maxProofBytes?: number;
  maxFileBytes?: number;
}

export class NotFoundError extends Error { override name = 'NotFoundError'; }
export interface AssetStat { size: number; contentType?: string; }

export class VerifiedAsset {
  #cid: string; #anchor: Cid; #anchorDigestHex: string; #kind: 'raw' | 'bundle';
  #store: VerifiedStore; #proofs: ProofSource | undefined; #maxFileBytes: number;

  constructor(options: VerifiedAssetOptions) {
    const { cid, source, proof, fetchFn, maxCacheBytes, maxProofBytes, maxFileBytes } = options;
    this.#anchor = parseAssetAnchor(cid); this.#cid = cid; this.#anchorDigestHex = toHex(this.#anchor.digest);
    this.#kind = this.#anchor.codec === DAG_CBOR_CODE ? 'bundle' : 'raw'; this.#maxFileBytes = maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    const bases = Array.isArray(source) ? source : [source];
    if (!bases.length || bases.some((base) => typeof base !== 'string' || !base.length)) throw new Error('source must be a base URL or a non-empty list of base URLs');
    const stripped = bases.map((base) => base.replace(/\/+$/, ''));
    if (this.#kind === 'raw' && proof !== undefined) throw new Error('proof is not valid for a raw anchor');
    this.#store = new VerifiedStore(stripped.map((base) => new RangeSource(base, { fetchFn: fetch })), { maxCacheBytes: maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES });
    if (this.#kind === 'bundle') {
      if (proof === undefined && stripped.some((base) => base.includes('?'))) throw new Error(`source ${stripped.find((base) => base.includes('?'))!} has a query string; an explicit proof URL is required`);
      const urls = proof === undefined ? stripped.map((base) => `${base}.car`) : Array.isArray(proof) ? proof : [proof];
      if (!urls.length || urls.some((url) => typeof url !== 'string' || !url.length)) throw new Error('proof must be a URL or a non-empty list of URLs');
      this.#proofs = new ProofSource(urls, { fetchFn: fetch, maxProofBytes: maxProofBytes ?? DEFAULT_MAX_PROOF_BYTES, stats: this.#store.stats });
    }
  }

  get cid(): string { return this.#cid; }
  get stats(): VerifyStats { return this.#store.stats; }

  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      return (await this.#store.fetchWhole('', this.#anchorDigestHex, ASSET_WHOLE_CAP, { signal })).slice();
    }
    const entry = await this.#entry(segments);
    if (entry.size > this.#maxFileBytes) throw new VerificationError('file exceeds maxFileBytes');
    const digest = toHex(entry.src.digest);
    const candidate = this.#proofs!.leafCandidate(digest);
    if (candidate !== undefined) {
      if (candidate.length === entry.size) {
        try {
          await verifyDigest(digest, candidate, 'manifest: raw section');
          this.#store.stats.verified++;
          return candidate.slice();
        } catch (err) {
          if (!(err instanceof VerificationError)) throw err;
        }
      }
      this.#proofs!.discardLeafCandidate(digest);
    }
    return (await this.#store.fetchWhole(segments.join('/'), digest, entry.size, { signal })).slice();
  }

  async stat(path = ''): Promise<AssetStat> {
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      throw new VerificationError('raw artifact has no declared size');
    }
    const { size, contentType } = await this.#entry(segments);
    return contentType === undefined ? { size } : { size, contentType };
  }

  async #entry(segments: string[]): Promise<ManifestEntry> {
    const entry = (await this.#proofs!.root(this.#anchor)).entries.get(pathKey(segments));
    if (entry === undefined) throw new NotFoundError(`not found: ${pathKey(segments)}`);
    return entry;
  }
}
