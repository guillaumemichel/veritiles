// MapLibre addProtocol handler for `verified://<anchor>/<path>` URLs.
// The URL carries the trust anchor, never the location: a registry maps each
// anchor to a VerifiedAsset whose content/proof URLs come from page config, so
// styles stay host-independent. A NotFound glyph range resolves to an empty
// response (MapLibre tolerates sparse ranges); every other error surfaces.
// MapLibre uses an answer as it is: a `json` request (a sprite index, a style)
// gets the parsed value, a `string` request the text, any other the bytes.

import { NotFoundError } from '@anymirror/core';

import type { VerifiedAsset } from './asset.ts';

const SCHEME = 'verified://';

// The answers in MapLibre's own types: parsed JSON is an `object`.
export interface AssetHandler {
  (params: { url: string; type: 'json' }, abort?: AbortController): Promise<{ data: object }>;
  (params: { url: string; type: 'string' }, abort?: AbortController): Promise<{ data: string }>;
  (params: { url: string; type?: 'arrayBuffer' | 'image' }, abort?: AbortController): Promise<{ data: ArrayBuffer }>;
  // Any request MapLibre makes, its type known only at run time.
  (params: { url: string; type?: string }, abort?: AbortController): Promise<{ data: ArrayBuffer | string | object }>;
}

export function assetProtocol(assets: VerifiedAsset[]): AssetHandler {
  const registry = new Map<string, VerifiedAsset>();
  for (const asset of assets) {
    if (registry.has(asset.cid)) throw new Error(`assetProtocol: duplicate anchor ${asset.cid}`);
    registry.set(asset.cid, asset);
  }

  const handler = async ({ url, type }: { url: string; type?: string }, abort?: AbortController) => {
    const { asset, path } = resolve(registry, url);
    try {
      return { data: answer(await asset.bytes(path, { signal: abort?.signal }), type) };
    } catch (err) {
      if (err instanceof NotFoundError && path.endsWith('.pbf')) {
        return { data: new ArrayBuffer(0) }; // a sparse glyph range, not an error
      }
      throw err;
    }
  };
  return handler as AssetHandler;
}

// The verified bytes, in the form the request asks for.
function answer(bytes: Uint8Array, type: string | undefined): ArrayBuffer | string | object {
  if (type === 'json') return JSON.parse(new TextDecoder().decode(bytes));
  if (type === 'string') return new TextDecoder().decode(bytes);
  // bytes is a fresh, exactly-sized copy; hand MapLibre its buffer directly.
  return bytes.buffer as ArrayBuffer;
}

function resolve(registry: Map<string, VerifiedAsset>, url: string): { asset: VerifiedAsset; path: string } {
  if (!url.startsWith(SCHEME)) throw new Error(`assetProtocol: not a verified:// URL: ${url}`);
  const segments = url.slice(SCHEME.length).split('/');
  const anchor = segments[0]!;
  const asset = registry.get(anchor);
  if (asset === undefined) throw new Error(`assetProtocol: unknown anchor ${anchor}`);
  const path = segments.slice(1).map(decodeURIComponent).join('/');
  return { asset, path };
}
