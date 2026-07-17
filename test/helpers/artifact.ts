// Reference artifact builder + fake host for the verified-assets suite,
// built with the CANONICAL IPLD stack (ipfs-unixfs-importer + @ipld/dag-pb +
// @ipld/car, dev-dependencies). Every fixture anchor/rootCid is computed by
// the reference importer under the A9 profile, so a test that resolves one
// cross-validates the library's zero-dependency decode/proof code against the
// real thing. The proof CAR is emitted in the A5/A9.1 canonical order, which
// also differentially checks the spec's fixed-header claim (F-06).

import { CarWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

import type { FetchFn } from '../../src/range-source.ts';

const RAW_CODE = 0x55;
const CAR_CODE = 0x0202;
const BLOCK_CAP = 262144;

export interface TreeEntry {
  path: string;
  bytes: Uint8Array;
}

export interface Artifact {
  /** The trust anchor (A2): raw CID text for a raw artifact, car CID for a DAG one. */
  anchor: string;
  /** The content root CID text (`dag-pb`, or the raw CID for a raw artifact). */
  rootCid: string;
  /** Published content by path — `''` is the file-artifact body; tree paths otherwise. */
  files: Map<string, Uint8Array>;
  /** The A5 proof CAR for a DAG artifact; absent for a raw one. */
  proof?: Uint8Array;
}

export interface BuildOptions {
  /** Fixed chunk size (default importer 256 KiB) — for cheap multi-leaf fixtures. */
  chunkSize?: number;
  /** Balanced-layout fan-out (default 174) — for deep-DAG fixtures. */
  maxChildrenPerNode?: number;
}

// interface-blockstore keys by multihash and loses the codec, so blocks are
// recorded at put() time under their full CID instead.
class RecordingBlockstore extends MemoryBlockstore {
  blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  override async put(cid: CID, bytes: Uint8Array): Promise<CID> {
    this.blocks.set(cid.toString(), { cid, bytes });
    return super.put(cid, bytes) as Promise<CID>;
  }
}

export async function buildArtifact(
  input: Uint8Array | TreeEntry[],
  opts: BuildOptions = {},
): Promise<Artifact> {
  const blockstore = new RecordingBlockstore();
  const importOptions = {
    rawLeaves: true,
    cidVersion: 1 as const,
    ...(opts.chunkSize !== undefined ? { chunker: fixedSize({ chunkSize: opts.chunkSize }) } : {}),
    ...(opts.maxChildrenPerNode !== undefined
      ? { layout: balanced({ maxChildrenPerNode: opts.maxChildrenPerNode }) }
      : {}),
  };

  const files = new Map<string, Uint8Array>();
  let root: CID | undefined;
  if (input instanceof Uint8Array) {
    for await (const entry of importer([{ content: input }], blockstore, importOptions)) {
      root = entry.cid;
    }
    files.set('', input);
  } else {
    const source = input.map((f) => ({ path: f.path, content: f.bytes }));
    for await (const entry of importer(source, blockstore, { ...importOptions, wrapWithDirectory: true })) {
      root = entry.cid; // the wrapping directory is emitted last
    }
    for (const f of input) files.set(f.path, f.bytes);
  }
  if (root === undefined) throw new Error('importer produced no root');

  if (root.code === RAW_CODE) {
    return { anchor: root.toString(), rootCid: root.toString(), files };
  }
  const proof = await buildProof(blockstore, root);
  const anchor = CID.createV1(CAR_CODE, await sha256.digest(proof));
  return { anchor: anchor.toString(), rootCid: root.toString(), files, proof };
}

// The A5/A9.1 canonical proof: a CARv1 of every dag-pb block reachable from
// the root, emitted depth-first parents-first — directory links in name order
// (as the importer stores them) and file links in index order — each block
// once, raw leaves skipped. Builders MUST fail rather than emit a sharded
// directory (A9) or a proof over 256 KiB (A9.1).
async function buildProof(blockstore: RecordingBlockstore, root: CID): Promise<Uint8Array> {
  const seen = new Set<string>();
  const order: { cid: CID; bytes: Uint8Array }[] = [];
  const walk = (cid: CID): void => {
    if (cid.code !== dagPb.code || seen.has(cid.toString())) return;
    seen.add(cid.toString());
    const block = blockstore.blocks.get(cid.toString());
    if (block === undefined) throw new Error(`missing block ${cid} while building proof`);
    const node = dagPb.decode(block.bytes);
    if (UnixFS.unmarshal(node.Data!).type === 'hamt-sharded-directory') {
      throw new Error('sharded directory: split the tree into several artifacts (A9)');
    }
    order.push({ cid, bytes: block.bytes });
    for (const link of node.Links) walk(link.Hash);
  };
  walk(root);

  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const { cid, bytes } of order) await writer.put({ cid, bytes });
  await writer.close();
  await drain;

  const proof = concat(chunks);
  if (proof.length > BLOCK_CAP) {
    throw new Error(`proof is ${proof.length} bytes, over the ${BLOCK_CAP} cap (A9.1)`);
  }
  return proof;
}

export interface ServeHooks {
  /** Replace a response body; return undefined to leave it unchanged. */
  tamper?: (url: string, bytes: Uint8Array) => Uint8Array | undefined;
  /** Force an HTTP status for a URL; return undefined for the normal response. */
  status?: (url: string) => number | undefined;
  /** 404 the `.car` proof only. */
  dropProof?: boolean;
}

export interface ServeEntry {
  base: string;
  fixture: Artifact;
  hooks?: ServeHooks;
}

export interface Server {
  fetch: FetchFn;
  /** Every requested URL, in order — the request-accounting seam. */
  requests: string[];
}

// A fake FetchFn serving one or more artifacts as a dumb host: `{base}` (file
// body), `{base}/{path}` (tree files, decoded per segment), `{base}.car`
// (proof). Records every URL; hooks tamper/status/dropProof per entry.
export function serveArtifact(entries: ServeEntry[]): Server {
  const routes = entries.map((entry) => ({
    ...entry,
    base: entry.base.replace(/\/+$/, ''),
  }));
  const requests: string[] = [];

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    signal?.throwIfAborted();
    requests.push(url);

    for (const route of routes) {
      const hit = resolveRoute(route, url);
      if (hit === undefined) continue;

      const forced = route.hooks?.status?.(url);
      if (forced !== undefined) return new Response('forced', { status: forced });
      if (hit.kind === 'proof' && route.hooks?.dropProof) {
        return new Response('no proof', { status: 404 });
      }
      if (hit.bytes === undefined) return new Response('not found', { status: 404 });

      const body = route.hooks?.tamper?.(url, hit.bytes) ?? hit.bytes;
      return new Response(new Uint8Array(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as FetchFn;

  return { fetch, requests };
}

interface RouteEntry {
  base: string;
  fixture: Artifact;
  hooks?: ServeHooks;
}

type Hit = { kind: 'proof' | 'content'; bytes: Uint8Array | undefined };

function resolveRoute(route: RouteEntry, url: string): Hit | undefined {
  if (url === `${route.base}.car`) {
    return { kind: 'proof', bytes: route.fixture.proof };
  }
  if (url === route.base) {
    return { kind: 'content', bytes: route.fixture.files.get('') };
  }
  if (url.startsWith(`${route.base}/`)) {
    const encoded = url.slice(route.base.length + 1);
    const path = encoded.split('/').map(decodeURIComponent).join('/');
    return { kind: 'content', bytes: route.fixture.files.get(path) };
  }
  return undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
