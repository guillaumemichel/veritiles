// MapLibre addProtocol handler for `verified://<anchor>/<path>` URLs (A10).
// The URL carries the trust anchor, never the location: a registry maps each
// anchor to a VerifiedAsset whose content/proof URLs come from page config, so
// styles stay host-independent. A NotFound glyph range resolves to an empty
// response (MapLibre tolerates sparse ranges); every other error surfaces.

import { NotFoundError, type VerifiedAsset } from './asset.ts';

const SCHEME = 'verified://';

export function assetProtocol(
  assets: VerifiedAsset[],
): (params: { url: string }, abort?: AbortController) => Promise<{ data: ArrayBuffer }> {
  const registry = new Map<string, VerifiedAsset>();
  for (const asset of assets) {
    if (registry.has(asset.cid)) throw new Error(`assetProtocol: duplicate anchor ${asset.cid}`);
    registry.set(asset.cid, asset);
  }

  return async ({ url }, abort) => {
    const { asset, path } = resolve(registry, url);
    try {
      const bytes = await asset.bytes(path, { signal: abort?.signal });
      // bytes is a fresh, exactly-sized copy; hand MapLibre its buffer directly.
      return { data: bytes.buffer as ArrayBuffer };
    } catch (err) {
      if (err instanceof NotFoundError && path.endsWith('.pbf')) {
        return { data: new ArrayBuffer(0) }; // a sparse glyph range, not an error
      }
      throw err;
    }
  };
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
