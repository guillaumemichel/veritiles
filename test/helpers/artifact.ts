import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

import { encodeManifest } from '../../src/manifest.ts';
import type { FetchFn } from '../../src/range-source.ts';

export interface TreeEntry { path: string; bytes: Uint8Array; contentType?: string; }
export interface Artifact { anchor: string; rootCid: string; files: Map<string, Uint8Array>; proof?: Uint8Array; srcCids?: Map<string, string>; }
export interface BuildOptions { inlineRaw?: boolean }

export async function buildArtifact(input: Uint8Array | TreeEntry[], { inlineRaw = true }: BuildOptions = {}): Promise<Artifact> {
  if (input instanceof Uint8Array) {
    const cid = CID.createV1(0x55, await sha256.digest(input));
    return { anchor: cid.toString(), rootCid: cid.toString(), files: new Map([['', input]]) };
  }
  const files = new Map(input.map(({ path, bytes }) => [path, bytes]));
  const srcCids = new Map<string, string>();
  const entries: [string, { src: { codec: number; hashCode: number; digest: Uint8Array; bytes: Uint8Array }; size: number; contentType?: string }][] = [];
  for (const file of input) {
    const cid = CID.createV1(0x55, await sha256.digest(file.bytes));
    srcCids.set(file.path, cid.toString());
    entries.push([`/${file.path}`, { src: { codec: cid.code, hashCode: cid.multihash.code, digest: cid.multihash.digest, bytes: cid.bytes }, size: file.bytes.length, ...(file.contentType === undefined ? {} : { contentType: file.contentType }) }]);
  }
  const manifest = encodeManifest(entries, { withType: true });
  const root = CID.createV1(0x71, await sha256.digest(manifest));
  const { writer, out } = CarWriter.create([root]);
  const chunks: Uint8Array[] = [];
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  await writer.put({ cid: root, bytes: manifest });
  const seen = new Set<string>();
  if (inlineRaw) for (const file of input) {
    const cid = CID.createV1(0x55, await sha256.digest(file.bytes));
    if (file.bytes.length <= 2 ** 23 && !seen.has(cid.toString())) { seen.add(cid.toString()); await writer.put({ cid, bytes: file.bytes }); }
  }
  await writer.close(); await drain;
  return { anchor: root.toString(), rootCid: root.toString(), files, proof: concat(chunks), srcCids };
}

export interface ServeHooks { tamper?: (url: string, bytes: Uint8Array) => Uint8Array | undefined; status?: (url: string) => number | undefined; dropProof?: boolean; }
export interface ServeEntry { base: string; fixture: Artifact; hooks?: ServeHooks; }
export interface Server { fetch: FetchFn; requests: string[]; }

export function serveArtifact(entries: ServeEntry[]): Server {
  const routes = entries.map((entry) => ({ ...entry, base: entry.base.replace(/\/+$/, '') }));
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); (init as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted(); requests.push(url);
    for (const route of routes) {
      let kind: 'proof' | 'content' | undefined; let bytes: Uint8Array | undefined;
      if (url === `${route.base}.car`) { kind = 'proof'; bytes = route.fixture.proof; }
      else if (url === route.base) { kind = 'content'; bytes = route.fixture.files.get(''); }
      else if (url.startsWith(`${route.base}/`)) { kind = 'content'; bytes = route.fixture.files.get(url.slice(route.base.length + 1).split('/').map(decodeURIComponent).join('/')); }
      if (kind === undefined) continue;
      const status = route.hooks?.status?.(url); if (status !== undefined) return new Response('forced', { status });
      if (kind === 'proof' && route.hooks?.dropProof) return new Response('missing', { status: 404 });
      if (bytes === undefined) return new Response('missing', { status: 404 });
      return new Response(new Uint8Array(route.hooks?.tamper?.(url, bytes) ?? bytes), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  }) as FetchFn;
  return { fetch, requests };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0)); let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
