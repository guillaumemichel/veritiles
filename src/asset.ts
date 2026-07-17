// A verified whole-file resource — a style, a sprite set, font glyphs, any
// directory tree — fetched from dumb HTTP hosts and authenticated against a
// single anchor CID (A2). A raw anchor names the file itself; a car anchor
// names a proof file (A5) whose verified root the DAG walk descends (A6–A7).
// Construction is synchronous and does no I/O; the first read of a DAG
// artifact lazily loads and memoizes the proof (A8). Every read returns a
// fresh copy, so callers may mutate freely.

import { type Cid, CAR_CODE, formatCidV1, parseAnchorCid, RAW_CODE } from './cid.ts';
import { BLOCK_CAP, parseProof } from './proof.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { readBody } from './read-body.ts';
import { decodeNode, findLink, type UnixFsNode } from './unixfs.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';
import { sha256, toHex, VerificationError, verifyDigest } from './verify.ts';

const MAX_FILE_BYTES = 64 * 1024 * 1024; // DAG file body bound (A12)
const MAX_CACHE_BYTES = 64 * 1024 * 1024; // verified-byte LRU budget
const MAX_SEGMENTS = 32; // path segment count (A7)
const MAX_NAME = 255; // path segment UTF-8 bytes (A6, A7)
const MAX_FILE_DEPTH = 8; // nested File-node recursion (A6)

export interface VerifiedAssetOptions {
  /** Anchor CID (A2): codec `raw` (content itself) or `car` (proof file). */
  cid: string;
  /** Content base URL(s) (A3), tried in order. */
  source: string | string[];
  /**
   * Proof URL(s), tried in order (A8). Default: `{base}.car` for each content
   * base. Only valid when `cid` has the `car` codec.
   */
  proof?: string | string[];
  /** Replaces global fetch — instrumentation and test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte LRU cache (default 64 MiB). */
  maxCacheBytes?: number;
  /** Per-file bound for DAG files (A12, default 64 MiB). */
  maxFileBytes?: number;
}

// Authenticated absence (A4): the artifact provably does not contain the path.
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

// The memoized result of loading a DAG artifact's proof: its verified root,
// the authenticated node blocks by digest hex, and a lazy decode cache.
interface Opened {
  root: Cid;
  blocks: Map<string, Uint8Array>;
  nodes: Map<string, UnixFsNode>;
}

export class VerifiedAsset {
  #cid: string;
  #anchor: Cid;
  #anchorDigestHex: string;
  #kind: 'raw' | 'dag';
  #store: VerifiedStore;
  #fetchFn: FetchFn;
  #proofUrls: string[];
  #maxFileBytes: number;
  #opened: Promise<Opened> | undefined;
  #rootText: string | undefined;

  constructor(options: VerifiedAssetOptions) {
    const { cid, source, proof, fetchFn, maxCacheBytes, maxFileBytes } = options;
    this.#anchor = parseAnchorCid(cid);
    this.#cid = cid;
    this.#anchorDigestHex = toHex(this.#anchor.digest);
    this.#kind = this.#anchor.codec === CAR_CODE ? 'dag' : 'raw';
    this.#maxFileBytes = maxFileBytes ?? MAX_FILE_BYTES;
    this.#fetchFn = fetchFn ?? ((...args: Parameters<FetchFn>) => fetch(...args));

    const bases = Array.isArray(source) ? source : [source];
    if (bases.length === 0 || bases.some((b) => typeof b !== 'string' || b.length === 0)) {
      throw new Error('source must be a base URL or a non-empty list of base URLs');
    }
    const stripped = bases.map((b) => b.replace(/\/+$/, ''));

    if (this.#kind === 'raw') {
      if (proof !== undefined) throw new Error('proof is not valid for a raw anchor');
      this.#proofUrls = [];
      this.#rootText = cid; // the anchor is the content root
    } else {
      const urls = proof === undefined ? stripped.map((b) => `${b}.car`) : Array.isArray(proof) ? proof : [proof];
      if (urls.length === 0 || urls.some((u) => typeof u !== 'string' || u.length === 0)) {
        throw new Error('proof must be a URL or a non-empty list of URLs');
      }
      this.#proofUrls = urls;
    }

    this.#store = new VerifiedStore(
      stripped.map((base) => new RangeSource(base, { fetchFn: this.#fetchFn })),
      { maxCacheBytes: maxCacheBytes ?? MAX_CACHE_BYTES },
    );
  }

  // The anchor — the registry key for assetProtocol.
  get cid(): string {
    return this.#cid;
  }

  // The verified artifact root CID for diagnostics (A8): the anchor itself for
  // a raw artifact, the proof's verified dag-pb root once loaded for a DAG one.
  get root(): string | undefined {
    return this.#rootText;
  }

  get stats(): VerifyStats {
    return this.#store.stats;
  }

  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const segments = splitPath(path);
    if (this.#kind === 'raw') {
      if (segments.length > 0) throw new VerificationError('raw artifact has no sub-paths');
      const bytes = await this.#store.fetchWhole('', this.#anchorDigestHex, BLOCK_CAP, { signal });
      return bytes.slice();
    }
    const opened = await this.#open();
    signal?.throwIfAborted();
    const cid = this.#walk(opened, segments);
    const bytes = await this.#fileBytes(opened, cid, segments.join('/'), { signal });
    return bytes.slice();
  }

  // Lazy memoized proof load (A8): shared by every concurrent read,
  // deliberately not tied to any caller's abort signal; a failure clears the
  // memo so the next read retries. Proof URLs are complete URLs, not `{base}`
  // members, so this bypasses RangeSource/VerifiedStore.
  #open(): Promise<Opened> {
    if (this.#opened === undefined) {
      this.#opened = this.#loadProof();
      this.#opened.catch(() => {
        this.#opened = undefined;
      });
    }
    return this.#opened;
  }

  async #loadProof(): Promise<Opened> {
    const errors: unknown[] = [];
    for (const url of this.#proofUrls) {
      try {
        const res = await this.#fetchFn(url);
        if (!res.ok) {
          void res.body?.cancel?.();
          throw new Error(`${url}: HTTP ${res.status}`); // transport: not counted
        }
        const body = await readBody(res, BLOCK_CAP);
        await verifyDigest(this.#anchorDigestHex, body, 'proof');
        const { root, blocks } = await parseProof(body, 'proof');
        this.#store.stats.verified++;
        this.#rootText = formatCidV1(root.codec, root.digest);
        return { root, blocks, nodes: new Map() };
      } catch (err) {
        // An oversized body, digest mismatch, or parse failure is an authored
        // fault: one rejected. Transport faults move on without counting.
        if (err instanceof VerificationError) this.#store.stats.rejected++;
        errors.push(err);
      }
    }
    throw new AggregateError(errors, 'proof: all sources failed');
  }

  // Descend directory nodes segment by segment (A7). A name absent from a
  // verified directory is authenticated absence (NotFound); a descent through a
  // file rejects; a missing/malformed node is a proof fault counted by #node.
  #walk(opened: Opened, segments: string[]): Cid {
    let cid = opened.root;
    for (const segment of segments) {
      const node = this.#node(opened, cid, 'walk');
      if (node.kind !== 'dir') throw new VerificationError('walk: path descends through a file');
      const index = findLink(node.links, segment);
      if (index === -1) throw new NotFoundError(`not found: ${segment}`);
      cid = node.links[index]!.cid;
    }
    return cid;
  }

  async #fileBytes(opened: Opened, cid: Cid, url: string, { signal }: { signal?: AbortSignal }): Promise<Uint8Array> {
    if (cid.codec === RAW_CODE) {
      // A raw leaf, or a single-chunk file: fetch whole and digest-check.
      return this.#store.fetchWhole(url, toHex(cid.digest), BLOCK_CAP, { signal });
    }
    // Resolve the file's structure from the proof BEFORE any content request:
    // a missing nested node or an oversized file is a proof/config fault, not a
    // content-source fault, so it must not fetch, count per-source, or ban.
    const { filesize, leaves } = this.#resolveFile(opened, cid);
    return this.#store.fetchChecked(
      url,
      `file:${toHex(cid.digest)}`, // kind-prefixed so leaf bytes can't be served for a node (A7 decision 7)
      filesize,
      (bytes) => this.#verifyContent(bytes, filesize, leaves),
      { signal },
    );
  }

  // Flatten a File node into its ordered raw leaves (A6–A7), reading only the
  // proof: depth cap, nested `filesize === blocksize`, and the whole leaf list.
  #resolveFile(opened: Opened, cid: Cid): { filesize: number; leaves: { size: number; digest: Uint8Array }[] } {
    const node = this.#node(opened, cid, 'file');
    if (node.kind !== 'file') throw new VerificationError('artifact path resolves to a directory');
    if (node.filesize > this.#maxFileBytes) {
      throw new VerificationError('file exceeds maxFileBytes'); // before any content request (A12)
    }
    const leaves: { size: number; digest: Uint8Array }[] = [];
    this.#collectLeaves(opened, node, 0, leaves);
    return { filesize: node.filesize, leaves };
  }

  #collectLeaves(
    opened: Opened,
    node: UnixFsNode & { kind: 'file' },
    depth: number,
    out: { size: number; digest: Uint8Array }[],
  ): void {
    if (depth > MAX_FILE_DEPTH) throw new VerificationError('file: DAG deeper than the depth cap');
    for (const part of node.parts) {
      if (part.cid.codec === RAW_CODE) {
        out.push({ size: part.blocksize, digest: part.cid.digest });
        continue;
      }
      const child = this.#node(opened, part.cid, 'file');
      if (child.kind !== 'file') throw new VerificationError('file: nested link is not a File node');
      if (child.filesize !== part.blocksize) throw new VerificationError('file: nested filesize ≠ blocksize');
      this.#collectLeaves(opened, child, depth + 1, out);
    }
  }

  // Verify an assembled file body against the resolved leaf list (A7): exact
  // length, then each consecutive slice against its raw-leaf digest. Runs as a
  // per-source check, so a mismatch here IS the content source's fault (ban).
  async #verifyContent(bytes: Uint8Array, filesize: number, leaves: { size: number; digest: Uint8Array }[]): Promise<void> {
    if (bytes.length !== filesize) throw new VerificationError('file: body length does not match filesize');
    let offset = 0;
    for (const leaf of leaves) {
      const slice = bytes.subarray(offset, offset + leaf.size);
      offset += leaf.size;
      await verifyDigest(toHex(leaf.digest), slice, 'file: leaf');
    }
  }

  // A proof node by CID digest hex — the lookup IS the A5/A6 authentication
  // (blocks were hash-checked against their section CIDs at parse). A miss or a
  // malformed authenticated block is a proof fault: one rejected (A8). Memoizes.
  #node(opened: Opened, cid: Cid, label: string): UnixFsNode {
    const key = toHex(cid.digest);
    const cached = opened.nodes.get(key);
    if (cached !== undefined) return cached;
    const block = opened.blocks.get(key);
    if (block === undefined) {
      this.#store.stats.rejected++;
      throw new VerificationError(`${label}: node block missing from proof`);
    }
    try {
      const node = decodeNode(block, label);
      opened.nodes.set(key, node);
      return node;
    } catch (err) {
      if (err instanceof VerificationError) this.#store.stats.rejected++;
      throw err;
    }
  }
}

// Split a request path into validated segments (A7). Runs before any fetch, so
// a bad path never touches the network.
function splitPath(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS) throw new VerificationError('path: too many segments');
  const encoder = new TextEncoder();
  for (const segment of segments) {
    if (segment.length === 0) throw new VerificationError('path: empty segment');
    if (segment === '.' || segment === '..') throw new VerificationError(`path: '${segment}' segment`);
    if (encoder.encode(segment).length > MAX_NAME) throw new VerificationError('path: segment over 255 bytes');
  }
  return segments;
}
