// The public entry point for range-verified files (PLAN-shards §1): a file
// anchored to a dag-cbor proof descriptor, read over one or more untrusted
// hosts. Construction is synchronous; the first read opens the file: it asks
// the router where the anchor's bytes live (SPEC §6; the built-in router
// follows the page's configuration and hints documents, SPEC §5), fetches
// `{proof}/root` (verifying it against the anchor — the one hash at open),
// then asks where the map lives. A failed open stays retryable. The open
// overlaps its round trip with the first shard and — with the built-in
// router, on a page that names its own source — the first reads' exact
// ranges, each verified when used like any fresh response. Reads clamp at EOF and return a fresh, exact-size copy
// — the content type (PMTiles, video, any file) is irrelevant to this class;
// per-type knowledge lives entirely in the packer.

import { abortable } from './abortable.ts';
import { type Cid, cidToText, parseFileAnchor } from './cid.ts';
import { DefaultRouter, type Hints } from './default-router.ts';
import { openDescriptor } from './descriptor.ts';
import { EarlySource } from './early-source.ts';
import { DEFAULT_MAX_CACHE_BYTES, PROOF_CACHE_BYTES } from './limits.ts';
import { Locator } from './locations.ts';
import { SHARD_FILE_CAP } from './proof-format.ts';
import { ProofIndex } from './proof-index.ts';
import { RangeSource } from './range-source.ts';
import { RangedReader } from './ranged-reader.ts';
import { type RangedByteSource, RangedStore } from './ranged-store.ts';
import type { Router, RouterOption } from '@anymirror/router';
import { type FetchFn, toRouter } from './routing.ts';
import { type ByteSource, VerifiedStore, type VerifyStats } from './verified-store.ts';

export interface VerifiedFileOptions {
  /** Anchor CID (PLAN-shards §1.1): dag-cbor, sha2-256 of the proof descriptor. */
  cid: string;
  /**
   * URL(s) of the file itself, tried in order. Range + 206 required. Optional:
   * a hints document (below) or a router may supply content locations instead.
   */
  source?: string | string[];
  /**
   * Proof base URL(s) — the directory holding `root` and the meta/shard
   * tree — tried in order. Default `{source}.proofs` per source; an
   * explicit value is required when a source URL carries a query string
   * (unless an explicit hints document supplies the proof base).
   */
  proof?: string | string[];
  /**
   * Hints documents and discovery, untrusted (SPEC §5): `hints()` turns them
   * on, `hints(url)` names the documents. Off by default: the file is read
   * at its configured locations and its router's alone. Every hinted byte
   * is verified against the anchor exactly as a configured one.
   */
  hints?: Hints;
  /**
   * Router, untrusted (SPEC §6): where a CID's bytes may live. It replaces
   * the built-in router, which it gets as `defaults` (the locations `source`,
   * `proof` and `hints` name), and may carry every request, hearing what
   * became of each. Every routed byte is verified like a configured one.
   */
  router?: RouterOption;
  /** Replaces global fetch — instrumentation, credentials, test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte LRU cache (default 64 MiB). */
  maxCacheBytes?: number;
}

export class VerifiedFile {
  #cid: string;
  #anchor: Cid;
  #anchorText: string;
  #router: Router | undefined;
  #locator: Locator;
  #fetch: FetchFn;
  #maxCacheBytes: number;
  #stats: VerifyStats = { verified: 0, rejected: 0 };
  #reader: Promise<RangedReader> | undefined;
  #built = false;
  // With the built-in router, the first configured source, kept across
  // opens: reads issued before the reader is built send their ranges to it
  // early.
  #firstContent: { url: string; source: EarlySource } | undefined;
  // The open's early `0`, until the first read has had its chance to claim it.
  #earlyProof: EarlySource | undefined;
  #size: number | undefined;

  constructor(options: VerifiedFileOptions) {
    const { cid, source, proof, hints, router, fetchFn, maxCacheBytes } = options;
    this.#anchor = parseFileAnchor(cid);
    this.#cid = cid;
    this.#anchorText = cidToText(this.#anchor);
    this.#fetch = fetchFn ?? ((...args: Parameters<FetchFn>) => globalThis.fetch(...args));
    this.#maxCacheBytes = maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.#router = toRouter(router);

    const sources = source === undefined ? [] : Array.isArray(source) ? source : [source];
    if (source !== undefined && (sources.length === 0 || sources.some((s) => typeof s !== 'string' || s.length === 0))) {
      throw new Error('source must be a URL or a non-empty list of URLs');
    }
    const defaults = new DefaultRouter({
      anchor: this.#anchorText,
      kind: 'ranged',
      sources,
      proof,
      hints,
      fetchFn: this.#fetch,
    });
    this.#locator = new Locator(this.#router, defaults);
    if (this.#router === undefined && sources.length > 0) {
      this.#firstContent = { url: sources[0]!, source: new EarlySource(new RangeSource(sources[0]!, { fetchFn: this.#fetch })) };
    }
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

  // Verified bytes for [offset, offset + length), clamped to EOF. An abort
  // stops this read waiting for the open, which goes on for the others.
  async read(offset: number, length: number, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const opening = this.#open();
    const release = this.#built ? undefined : this.#sendEarly(offset, length, signal);
    let opened = false;
    try {
      const reader = await abortable(opening, signal);
      opened = true;
      return await reader.read(offset, length, { signal });
    } finally {
      release?.();
      // A read past the open has had its chance at the early `0`: drop what is left.
      if (opened) {
        this.#earlyProof?.dropUnclaimed();
        this.#earlyProof = undefined;
      }
    }
  }

  // Before the reader exists, send the read's exact range to the first
  // configured source now — it rides the open's round trip, and the read's
  // speculation adopts (verifies) it. Clamped at EOF, the read asks for a
  // different range and the early body goes unused; it is dropped either way
  // when the read settles.
  #sendEarly(offset: number, length: number, signal: AbortSignal | undefined): (() => void) | undefined {
    if (offset < 0 || length <= 0) return undefined;
    return this.#firstContent?.source.sendRange('', offset, length, signal);
  }

  // Lazy memoized open. A failure clears the memo so the next read retries
  // (a router whose locations all failed is asked again); deliberately not
  // tied to any caller's abort signal.
  #open(): Promise<RangedReader> {
    if (this.#reader === undefined) {
      this.#reader = this.#build();
      this.#reader.catch(() => {
        this.#reader = undefined;
      });
    }
    return this.#reader;
  }

  // Verify the descriptor at the anchor's locations, seed the proof index,
  // locate the map, build the read loop. With a location held already, `root`
  // and `0` leave before the first read's early range.
  async #build(): Promise<RangedReader> {
    const anchor = this.#locator.for(this.#anchorText, { kind: 'proof', label: this.#cid, accept: isProofRoot });
    // A top meta that starts with a shard names it `0` (it starts the file):
    // fetch it right behind `root`, where `root` goes first — at once if
    // `root` left at once, else as soon as it leaves. The first read claims
    // it if it needs it.
    let early = undefined as EarlySource | undefined; // set in a callback: the cast stops TS narrowing it
    let opening = true;
    const sourceFor = (location: string): ByteSource => {
      const source = new EarlySource(this.#proofSource(location));
      if (early === undefined) {
        early = this.#earlyProof = source;
        if (!opening) queueMicrotask(() => source.sendWhole('0', SHARD_FILE_CAP));
      }
      return source;
    };
    const proofStore = new VerifiedStore({ locations: anchor, sourceFor }, { maxCacheBytes: PROOF_CACHE_BYTES, stats: this.#stats });
    const described = openDescriptor(this.#anchor, proofStore);
    opening = false;
    early?.sendWhole('0', SHARD_FILE_CAP);
    try {
      const descriptor = await described;
      const index = new ProofIndex(proofStore, {
        topMeta: descriptor.topMeta,
        fileSize: descriptor.mapSize,
      });
      const size = await index.open();
      this.#size = size;
      const contentStore = await this.#contentStore(cidToText(descriptor.mapCid));
      this.#built = true;
      return new RangedReader(contentStore, index, '', size);
    } catch (err) {
      early?.dropUnclaimed();
      throw err;
    }
  }

  // The map's store, once it has a location: none at all fails the open, and
  // the next open asks the router again. The proof files and the map file
  // share the stats object (one {verified, rejected} pair per client) but
  // each store gets its own LRU: proofs are tiny and immutable.
  async #contentStore(mapText: string): Promise<RangedStore> {
    const content = this.#locator.for(mapText, { kind: 'content' });
    if (!content.held().length) await content.pull();
    if (!content.held().length) {
      content.exhausted();
      throw content.unlocated();
    }
    return new RangedStore(
      { locations: content, sourceFor: (location) => this.#contentSource(location, mapText) },
      { maxCacheBytes: this.#maxCacheBytes, stats: this.#stats },
    );
  }

  // `{proof}/root` locates the descriptor; the proof tree is its directory.
  #proofSource(location: string): RangedByteSource {
    const base = location.slice(0, -'/root'.length);
    return new RangeSource(base, { fetchFn: this.#fetch, route: { router: this.#router, cid: this.#anchorText, location } });
  }

  // The first configured source holds the early reads' responses: reuse it,
  // so their speculation finds them.
  #contentSource(location: string, mapText: string): RangedByteSource {
    if (location === this.#firstContent?.url) return this.#firstContent.source;
    return new RangeSource(location, { fetchFn: this.#fetch, route: { router: this.#router, cid: mapText, location } });
  }
}

// A location's bytes root the derived proof tree only as `{proof}/root`
// (SPEC §2.2), and only without a query string.
function isProofRoot(url: string): boolean {
  return url.endsWith('/root') && !url.includes('?');
}
