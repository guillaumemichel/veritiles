// Verified raw files and MASL bundles served from ordinary HTTP hosts.
// Construction is synchronous and validates the anchor and configured
// locations; stores are built lazily at first read, so hinted locations
// (SPEC §5) — known only once a document is fetched — join the configured
// ones. Every byte, hinted or configured, verifies against the anchor.

import { type Cid, cidToText, DAG_CBOR_CODE, parseAssetAnchor } from './cid.ts';
import { containingDir, HintResolver } from './hints.ts';
import {
  ASSET_WHOLE_CAP,
  DEFAULT_MAX_CACHE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PROOF_BYTES,
} from './limits.ts';
import { pathKey, splitPath, type ManifestEntry } from './manifest.ts';
import { ProofSource } from './proof-source.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { type Candidate, VerifiedStore, type VerifyStats } from './verified-store.ts';
import { toHex, verifyDigest, VerificationError } from './verify.ts';

export interface VerifiedAssetOptions {
  /** Content anchor: raw for one file or dag-cbor for a MASL bundle. */
  cid: string;
  /** Base URL(s) of the artifact, tried in order. Optional: hints may supply them. */
  source?: string | string[];
  proof?: string | string[];
  /** Routing-hints document URL(s), untrusted (SPEC §5); defaults to `./hints.json`. */
  hints?: string | string[];
  fetchFn?: FetchFn;
  maxCacheBytes?: number;
  maxProofBytes?: number;
  maxFileBytes?: number;
}

export class NotFoundError extends Error { override name = 'NotFoundError'; }
export interface AssetStat { size: number; contentType?: string; }

export class VerifiedAsset {
  #cid: string; #anchor: Cid; #anchorDigestHex: string; #anchorText: string; #kind: 'raw' | 'bundle';
  #sources: string[]; #configuredProofUrls: string[] | undefined; #resolver: HintResolver; #hintsExplicit: boolean;
  #fetch: FetchFn; #maxCacheBytes: number; #maxProofBytes: number; #maxFileBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #storeMemo: Promise<VerifiedStore> | undefined; #proofsMemo: Promise<ProofSource> | undefined;
  // Bundle per-resource reads: configured bases as stable sources, a store that
  // holds only cache/bans/stats (candidates arrive per call), and a per-URL
  // cache so a ban on a lying hinted host persists across resources (decision 5).
  #bundleSources: RangeSource[]; #bundleStore: VerifiedStore; #urlSources = new Map<string, RangeSource>();

  constructor(options: VerifiedAssetOptions) {
    const { cid, source, proof, hints, fetchFn, maxCacheBytes, maxProofBytes, maxFileBytes } = options;
    this.#anchor = parseAssetAnchor(cid); this.#cid = cid; this.#anchorDigestHex = toHex(this.#anchor.digest); this.#anchorText = cidToText(this.#anchor);
    this.#kind = this.#anchor.codec === DAG_CBOR_CODE ? 'bundle' : 'raw';
    this.#maxCacheBytes = maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES; this.#maxProofBytes = maxProofBytes ?? DEFAULT_MAX_PROOF_BYTES; this.#maxFileBytes = maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args)); this.#hintsExplicit = hints !== undefined;
    const bases = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (!bases.length || bases.some((base) => typeof base !== 'string' || !base.length))) throw new Error('source must be a base URL or a non-empty list of base URLs');
    this.#sources = bases.map((base) => base.replace(/\/+$/, ''));
    if (this.#kind === 'raw' && proof !== undefined) throw new Error('proof is not valid for a raw anchor');
    this.#configuredProofUrls = this.#kind === 'bundle' ? this.#deriveProofUrls(this.#sources, proof) : undefined;
    this.#resolver = new HintResolver({ hints, fetchFn: this.#fetch });
    this.#bundleSources = this.#sources.map((base) => new RangeSource(base, { fetchFn: this.#fetch }));
    this.#bundleStore = new VerifiedStore([], { allowEmpty: true, maxCacheBytes: this.#maxCacheBytes, stats: this.#stats });
  }

  // Bundle proof CAR URLs from configuration alone: explicit `proof`, else
  // `{base}.car` per base, else undefined — hints must supply them. A query-string
  // base needs an explicit proof, unless explicit hints defer it to open.
  #deriveProofUrls(bases: string[], proof: string | string[] | undefined): string[] | undefined {
    if (proof !== undefined) {
      const urls = Array.isArray(proof) ? proof : [proof];
      if (!urls.length || urls.some((url) => typeof url !== 'string' || !url.length)) throw new Error('proof must be a URL or a non-empty list of URLs');
      return urls;
    }
    if (!bases.length) return undefined;
    const bad = bases.find((base) => base.includes('?'));
    if (bad !== undefined) {
      if (this.#hintsExplicit) return undefined;
      throw new Error(`source ${bad} has a query string; an explicit proof URL is required`);
    }
    return bases.map((base) => `${base}.car`);
  }

  get cid(): string { return this.#cid; }
  get stats(): VerifyStats { return this.#stats; }

  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      return (await (await this.#contentStore()).fetchWhole('', this.#anchorDigestHex, ASSET_WHOLE_CAP, { signal })).slice();
    }
    const proofs = await this.#proofSource();
    const entry = await this.#entry(proofs, segments);
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
    const candidates = await this.#resourceCandidates(entry, segments.join('/'), signal);
    return (await this.#bundleStore.fetchCheckedCandidates(candidates, digest, entry.size, (bytes) => verifyDigest(digest, bytes, 'bundle content'), { signal })).slice();
  }

  // Where one bundle resource may live: every configured base at `{base}/{path}`,
  // then hints[src] URLs serving the whole file (SPEC §5). Hinted URLs are
  // consulted lazily — when explicit, or when no source is configured. A src
  // with no location left probes beside the proof CARs before failing.
  async #resourceCandidates(entry: ManifestEntry, path: string, signal: AbortSignal | undefined): Promise<Candidate[]> {
    const srcText = cidToText(entry.src);
    const configured = this.#bundleSources.map((source) => ({ source, path }));
    const hinted = this.#hintsExplicit || this.#bundleSources.length === 0
      ? (await this.#resolver.urlsFor(srcText, { signal })).map((url) => ({ source: this.#urlSource(url), path: '' }))
      : [];
    let candidates = [...configured, ...hinted];
    if (!candidates.length) {
      const probedUrls = await this.#probeSrc(srcText, signal);
      candidates = probedUrls.map((url) => ({ source: this.#urlSource(url), path: '' }));
    }
    if (!candidates.length) throw this.#unlocated('content', srcText);
    return candidates;
  }

  // No location for a bundle src: probe the directory containing each known
  // proof CAR (SPEC §5 discovery — a file location's containing directory),
  // newly learned CARs included, until the src is located, directories run
  // out, or the resolver's document cap trips.
  async #probeSrc(srcText: string, signal: AbortSignal | undefined): Promise<string[]> {
    const probed = new Set<string>();
    for (;;) {
      const carUrls = dedupe([
        ...(this.#configuredProofUrls ?? []),
        ...await this.#resolver.urlsFor(this.#anchorText, { signal }),
      ]);
      const dirs = carUrls.map(containingDir).filter((dir) => !probed.has(dir));
      if (!dirs.length) return [];
      for (const dir of dirs) { probed.add(dir); await this.#resolver.probe(dir, { signal }); }
      const urls = await this.#resolver.urlsFor(srcText, { signal });
      if (urls.length) return urls;
    }
  }

  // One stable RangeSource per hinted URL, so a ban on a lying host outlives the
  // read that caught it and is skipped by every later resource that names it.
  #urlSource(url: string): RangeSource {
    let source = this.#urlSources.get(url);
    if (source === undefined) {
      source = new RangeSource(url, { fetchFn: this.#fetch });
      this.#urlSources.set(url, source);
    }
    return source;
  }

  async stat(path = ''): Promise<AssetStat> {
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length) throw new VerificationError('raw artifact has no sub-paths');
      throw new VerificationError('raw artifact has no declared size');
    }
    const { size, contentType } = await this.#entry(await this.#proofSource(), segments);
    return contentType === undefined ? { size } : { size, contentType };
  }

  async #entry(proofs: ProofSource, segments: string[]): Promise<ManifestEntry> {
    const entry = (await proofs.root(this.#anchor)).entries.get(pathKey(segments));
    if (entry === undefined) throw new NotFoundError(`not found: ${pathKey(segments)}`);
    return entry;
  }

  // Lazy, memoized content store: configured bases, plus — for a raw anchor —
  // hints[anchor] locating the whole file (appended when explicit or when
  // configuration names no source). A failed hint fetch is not memoized.
  #contentStore(): Promise<VerifiedStore> {
    if (this.#storeMemo === undefined) {
      this.#storeMemo = (async () => {
        const configured = this.#sources;
        const hinted = this.#kind === 'raw' && (this.#hintsExplicit || configured.length === 0)
          ? await this.#resolver.urlsFor(this.#anchorText)
          : [];
        const urls = dedupe([...configured, ...hinted]);
        if (!urls.length) throw this.#unlocated('content', this.#cid);
        return new VerifiedStore(urls.map((base) => new RangeSource(base, { fetchFn: this.#fetch })), { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats });
      })();
      this.#storeMemo.catch(() => { this.#storeMemo = undefined; });
    }
    return this.#storeMemo;
  }

  // Lazy, memoized proof source: configured/derived CAR URLs first, completed
  // by hints[anchor] (the proof CAR location for a bundle) when hints are
  // explicit or configuration derives nothing. Still empty, probe the
  // containing directory of each configured base (SPEC §5 discovery; the only
  // reachable base here carries a query string, so its containing directory is
  // the one clean derivable directory). One round is complete discovery:
  // before the manifest verifies, the anchor is the only CID the client may
  // look up, and any hit fills the class. Bans and root memoization persist
  // for the client's lifetime; a failed hint fetch is retryable.
  #proofSource(): Promise<ProofSource> {
    if (this.#proofsMemo === undefined) {
      this.#proofsMemo = (async () => {
        const configured = this.#configuredProofUrls ?? [];
        const hinted = this.#hintsExplicit || this.#configuredProofUrls === undefined
          ? await this.#resolver.urlsFor(this.#anchorText)
          : [];
        let urls = dedupe([...configured, ...hinted]);
        if (!urls.length && this.#sources.length) {
          for (const base of this.#sources) await this.#resolver.probe(containingDir(base));
          urls = await this.#resolver.urlsFor(this.#anchorText);
        }
        if (!urls.length) throw this.#unlocated('proof', this.#cid);
        return new ProofSource(urls, { fetchFn: this.#fetch, maxProofBytes: this.#maxProofBytes, stats: this.#stats });
      })();
      this.#proofsMemo.catch(() => { this.#proofsMemo = undefined; });
    }
    return this.#proofsMemo;
  }

  #unlocated(kind: string, cid: string): Error {
    const docs = this.#resolver.consulted();
    return new Error(`no ${kind} location for ${cid}; consulted ${docs.length ? docs.join(', ') : 'no hints documents'}`);
  }
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) { if (!seen.has(url)) { seen.add(url); out.push(url); } }
  return out;
}
