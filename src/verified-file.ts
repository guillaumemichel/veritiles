// The public entry point for range-verified files (PLAN-shards §1): a file
// anchored to a dag-cbor proof descriptor, read over one or more untrusted
// hosts. Construction is synchronous; the first read lazily resolves locations
// (configured, then hinted — SPEC §5), fetches `{proof}/root` (verifying
// it against the anchor — the one hash at open), and a failed open stays
// retryable. The open overlaps its round trip with the first shard and the
// first reads' exact ranges, each verified when used like any fresh
// response. Reads clamp at EOF and return a fresh, exact-size copy — the
// content type (PMTiles, video, any file) is irrelevant to this class; per-type
// knowledge lives entirely in the packer.

import { type Cid, cidToText, parseFileAnchor } from './cid.ts';
import { openDescriptor } from './descriptor.ts';
import { EarlySource } from './early-source.ts';
import { containingDir, HintResolver } from './hints.ts';
import { DEFAULT_MAX_CACHE_BYTES, PROOF_CACHE_BYTES } from './limits.ts';
import { SHARD_FILE_CAP } from './proof-format.ts';
import { ProofIndex } from './proof-index.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { RangedReader } from './ranged-reader.ts';
import { type ByteSource, VerifiedStore, type VerifyStats } from './verified-store.ts';

export interface VerifiedFileOptions {
  /** Anchor CID (PLAN-shards §1.1): dag-cbor, sha2-256 of the proof descriptor. */
  cid: string;
  /**
   * URL(s) of the file itself, tried in order. Range + 206 required. Optional:
   * a hints document (below) may supply content locations instead.
   */
  source?: string | string[];
  /**
   * Proof base URL(s) — the directory holding `root` and the meta/shard
   * tree — tried in order. Default `{source}.proofs` per source; an
   * explicit value is required when a source URL carries a query string
   * (unless a hints document supplies the proof base).
   */
  proof?: string | string[];
  /**
   * Routing-hints document URL(s), untrusted (SPEC §5). An explicit value is
   * consulted whenever locations resolve and its URLs join failover after the
   * configured ones; the default (`./hints.json` beside the page) is consulted
   * only when a location is missing. Every hinted byte is verified against the
   * anchor exactly as a configured one.
   */
  hints?: string | string[];
  /** Replaces global fetch — instrumentation and test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte LRU cache (default 64 MiB). */
  maxCacheBytes?: number;
}

export class VerifiedFile {
  #cid: string;
  #anchor: Cid;
  #anchorText: string;
  #sources: string[];
  #configuredProofBases: string[] | undefined;
  #resolver: HintResolver;
  #hintsExplicit: boolean;
  #fetch: FetchFn;
  #maxCacheBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #reader: Promise<RangedReader> | undefined;
  #built = false;
  // The first configured content source, kept across opens: reads issued
  // before the reader is built send their ranges to it early.
  #firstContent: EarlySource | undefined;
  #size: number | undefined;

  constructor(options: VerifiedFileOptions) {
    const { cid, source, proof, hints, fetchFn, maxCacheBytes } = options;
    this.#anchor = parseFileAnchor(cid);
    this.#cid = cid;
    this.#anchorText = cidToText(this.#anchor);
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    this.#maxCacheBytes = maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.#hintsExplicit = hints !== undefined;

    const sources = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (sources.length === 0 || sources.some((s) => typeof s !== 'string' || s.length === 0))) {
      throw new Error('source must be a URL or a non-empty list of URLs');
    }
    this.#sources = sources;
    if (sources.length > 0) this.#firstContent = new EarlySource(new RangeSource(sources[0]!, { fetchFn: this.#fetch }));
    this.#configuredProofBases = this.#configuredProof(sources, proof);
    this.#resolver = new HintResolver({ hints, fetchFn: this.#fetch });
  }

  // Proof bases from configuration alone: explicit `proof`, else `{source}.proofs`
  // derived from each source, else undefined — a hints document must supply them
  // (SPEC §5). A query-string source with no explicit proof is a config
  // error, left early and loud, unless explicit hints defer the question to open.
  #configuredProof(sources: string[], proof: string | string[] | undefined): string[] | undefined {
    if (proof !== undefined) {
      const urls = Array.isArray(proof) ? proof : [proof];
      if (urls.length === 0 || urls.some((u) => typeof u !== 'string' || u.length === 0)) {
        throw new Error('proof must be a URL or a non-empty list of URLs');
      }
      return urls;
    }
    if (sources.length === 0) return undefined;
    const bad = sources.find((s) => s.includes('?'));
    if (bad !== undefined) {
      if (this.#hintsExplicit) return undefined;
      throw new Error(`source ${bad} has a query string; an explicit proof URL is required`);
    }
    return sources.map((s) => `${s}.proofs`);
  }

  get cid(): string {
    return this.#cid;
  }

  get size(): number | undefined {
    return this.#size;
  }

  get stats(): VerifyStats {
    return this.#stats;
  }

  // Open eagerly instead of on the first read — optional; surfaces a bad anchor
  // or unreachable proof host before the first byte is needed.
  async ready(): Promise<void> {
    await this.#open();
  }

  // Verified bytes for [offset, offset + length), clamped to EOF.
  async read(offset: number, length: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const opening = this.#open();
    const release = this.#built ? undefined : this.#sendEarly(offset, length, signal);
    try {
      const reader = await opening;
      return await reader.read(offset, length, { signal });
    } finally {
      release?.();
    }
  }

  // Before the reader exists, send the read's exact range to the first
  // configured source now — it rides the open's round trip, and the read's
  // speculation adopts (verifies) it. Clamped at EOF, the read asks for a
  // different range and the early body goes unused; it is dropped either way
  // when the read settles.
  #sendEarly(offset: number, length: number, signal: AbortSignal | undefined): (() => void) | undefined {
    if (offset < 0 || length <= 0) return undefined;
    return this.#firstContent?.sendRange('', offset, length, signal);
  }

  // Lazy memoized open. A failure clears the memo so the next read retries
  // (failed hint fetches are not memoized); deliberately not tied to any
  // caller's abort signal.
  #open(): Promise<RangedReader> {
    if (this.#reader === undefined) {
      this.#reader = this.#build();
      this.#reader.catch(() => {
        this.#reader = undefined;
      });
    }
    return this.#reader;
  }

  // Resolve proof locations, verify the descriptor, seed the proof index,
  // resolve content locations, build the read loop. Configured proof
  // locations need no await, so `root` and `0` leave before the first read's
  // early range.
  async #build(): Promise<RangedReader> {
    const proofBases = this.#knownProofBases() ?? (await this.#resolveProofBases());
    const [first, ...rest] = proofBases.map((base) => new RangeSource(base, { fetchFn: this.#fetch }));
    const firstProof = new EarlySource(first!);
    const proofStore = new VerifiedStore([firstProof, ...rest], { maxCacheBytes: PROOF_CACHE_BYTES, stats: this.#stats });
    const opening = openDescriptor(this.#anchor, proofStore);
    // A top meta that starts with a shard names it `0` (it starts the file):
    // fetch it alongside `root`; the descent claims it if it needs it.
    firstProof.sendWhole('0', SHARD_FILE_CAP);
    const descriptor = await opening;
    const index = new ProofIndex(proofStore, {
      topMeta: descriptor.topMeta,
      fileSize: descriptor.mapSize,
    });
    const size = await index.open();
    this.#size = size;
    const contentStore = await this.#openContentStore(descriptor.mapCid, proofBases);
    this.#built = true;
    return new RangedReader(contentStore, index, '', size);
  }

  // Proof bases from configuration alone, when no hints document has a say.
  #knownProofBases(): string[] | undefined {
    if (this.#hintsExplicit || this.#configuredProofBases === undefined) return undefined;
    return dedupe(this.#configuredProofBases);
  }

  // Proof bases when hints have a say: configured/derived first, completed by
  // hints[anchor] (a proof base carries `{u}/root`, so a query string has no
  // clean anchor and is dropped). Hints are consulted when explicit, or when
  // configuration derives nothing. Still empty, probe the containing directory
  // of each configured source (SPEC §5 discovery — a file location's directory
  // may hold its hints) before failing. One round is complete discovery for
  // this class: before the descriptor verifies, the anchor is the only CID the
  // client may look up (§5 verify-then-locate), and any hints[anchor] hit
  // fills the class — there is nothing further to chain through.
  async #resolveProofBases(): Promise<string[]> {
    const configured = this.#configuredProofBases ?? [];
    let bases = dedupe([...configured, ...(await this.#lookupProofBases())]);
    if (bases.length === 0 && this.#sources.length > 0) {
      for (const source of this.#sources) await this.#resolver.probe(containingDir(source));
      bases = await this.#lookupProofBases();
    }
    if (bases.length === 0) throw this.#unlocated('proof', this.#cid);
    return bases;
  }

  async #lookupProofBases(): Promise<string[]> {
    return (await this.#resolver.urlsFor(this.#anchorText)).filter((u) => !u.includes('?'));
  }

  // Content sources: configured, plus hints[map] (consulted when explicit or
  // when no source is configured). Missing everywhere, probe the known proof
  // directories for an in-directory document (SPEC §5) before failing.
  // The proof files share the stats object (one {verified, rejected} pair per
  // client) but each store gets its own small LRU: proofs are tiny and immutable.
  async #openContentStore(mapCid: Cid, proofBases: string[]): Promise<VerifiedStore> {
    const mapText = cidToText(mapCid);
    const configured = this.#sources;
    const hinted = this.#hintsExplicit || configured.length === 0 ? await this.#resolver.urlsFor(mapText) : [];
    let urls = dedupe([...configured, ...hinted]);
    if (urls.length === 0) urls = await this.#probeContent(mapText, proofBases);
    if (urls.length === 0) throw this.#unlocated('content', mapText);
    return new VerifiedStore(
      urls.map((url) => this.#contentSource(url)),
      { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats },
    );
  }

  // The first configured source holds the early reads' responses: reuse it,
  // so their speculation finds them.
  #contentSource(url: string): ByteSource {
    if (url === this.#sources[0] && this.#firstContent !== undefined) return this.#firstContent;
    return new RangeSource(url, { fetchFn: this.#fetch });
  }

  // A directory a client knows may carry `{u}/hints.json` (SPEC §5).
  // Probe the known proof directories for the missing content location, then
  // any proof directories those documents name in turn (location → document →
  // location), until the class is filled, directories run out, or the resolver's
  // document cap trips. Probes never fire on the happy path.
  async #probeContent(mapText: string, proofBases: string[]): Promise<string[]> {
    const probed = new Set<string>();
    let dirs = proofBases;
    while (dirs.length) {
      for (const dir of dirs) {
        if (probed.has(dir)) continue;
        probed.add(dir);
        await this.#resolver.probe(dir);
      }
      const urls = await this.#resolver.urlsFor(mapText);
      if (urls.length) return urls;
      const learned = (await this.#resolver.urlsFor(this.#anchorText)).filter((u) => !u.includes('?'));
      dirs = learned.filter((dir) => !probed.has(dir));
    }
    return [];
  }

  #unlocated(kind: string, cid: string): Error {
    const docs = this.#resolver.consulted();
    const where = docs.length ? docs.join(', ') : 'no hints documents';
    return new Error(`no ${kind} location for ${cid}; consulted ${where}`);
  }
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
