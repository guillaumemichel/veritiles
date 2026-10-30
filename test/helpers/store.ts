// Stores over fixed lists, as the built-in router would hand them over: the
// locations are the page's own, all there at once. And the in-memory hosts
// the store tests read from.

import { type DefaultLocations, Locator, type Locations } from '../../packages/core/src/locations.ts';
import { type RangedByteSource, RangedStore } from '../../packages/core/src/ranged-store.ts';
import type { Router, Verdict } from '../../packages/router/src/index.ts';
import { type ByteSource, VerifiedStore, type VerifyStats } from '../../packages/core/src/verified-store.ts';
import { equalBytes, VerificationError } from '../../packages/core/src/verify.ts';

export function fixedLocations(urls: string[], cid = 'fixed'): Locations {
  const page = { open: () => ({ configured: urls, rest: (async function* () {})() }), consulted: () => [] };
  return new Locator(undefined, page).for(cid, { kind: 'content' });
}

// A store trying `sources` in order.
export function storeOf(sources: ByteSource[], opts: { maxCacheBytes?: number; stats?: VerifyStats } = {}): VerifiedStore {
  const locations = fixedLocations(sources.map((_, i) => String(i)));
  return new VerifiedStore({ locations, sourceFor: (location) => sources[Number(location)]! }, opts);
}

// The same, reading byte runs too.
export function rangedStoreOf(sources: RangedByteSource[], opts: { maxCacheBytes?: number; stats?: VerifyStats } = {}): RangedStore {
  const locations = fixedLocations(sources.map((_, i) => String(i)));
  return new RangedStore({ locations, sourceFor: (location) => sources[Number(location)]! }, opts);
}

// Transport-agnostic in-memory source. The store owns verification,
// failover, dedup, and caching, so its tests only need *a* source that
// serves whole files by path and ranges out of a backing buffer, honours
// abort, and can be told to fail or tamper to drive the error paths.
export function memorySource(
  {
    files = new Map(),
    buffer = new Uint8Array(0),
  }: { files?: Map<string, Uint8Array>; buffer?: Uint8Array } = {},
  {
    fail,
    tamper,
    onRequest,
    verdicts,
  }: {
    fail?: boolean | (() => boolean);
    tamper?: (bytes: Uint8Array) => Uint8Array | undefined;
    onRequest?: (what: string) => void;
    verdicts?: Verdict[];
  } = {},
): RangedByteSource {
  const down = () => (typeof fail === 'function' ? fail() : fail === true);
  return {
    fetchWhole: async (path, _cap, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`whole:${path}`);
      if (down()) throw new Error('source down');
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return body(new Uint8Array(tamper ? (tamper(bytes) ?? bytes) : bytes), verdicts);
    },
    fetchRange: async (path, start, length, { signal } = {}) => {
      signal?.throwIfAborted();
      onRequest?.(`range:${path}:${start}+${length}`);
      if (down()) throw new Error('source down');
      const slice = buffer.subarray(start, start + length);
      return body(new Uint8Array(tamper ? (tamper(slice) ?? slice) : slice), verdicts);
    },
  };
}

// A response, its verdicts recorded when asked to.
export const body = (bytes: Uint8Array, verdicts?: Verdict[]) => ({ bytes, settle: (v: Verdict) => verdicts?.push(v) });

// A check passing exactly `want`.
export const okCheck = (want: Uint8Array) => async (bytes: Uint8Array) => {
  if (!equalBytes(bytes, want)) throw new VerificationError('bytes do not match');
};

export const noDefaults: DefaultLocations = { open: () => ({ configured: [], rest: (async function* () {})() }), consulted: () => [] };

// The locations a router yields for one CID, each an in-memory host named by
// `https://{name}`, for a store to read: `down` holds the names failing in
// transport, and every request is logged by name.
export function routedHosts(
  locate: (urls: (...names: string[]) => string[]) => ReturnType<Router['locate']>,
  { files = new Map(), buffer = new Uint8Array(0) }: { files?: Map<string, Uint8Array>; buffer?: Uint8Array } = {},
) {
  const log: string[] = [];
  const down = new Set<string>();
  const verdicts: Record<string, Verdict[]> = {};
  const urls = (...names: string[]) => names.map((name) => `https://${name}`);
  const locations = new Locator({ locate: () => locate(urls) }, noDefaults).for('bafkfile', { kind: 'content' });
  const sourceFor = (location: string) => {
    const name = new URL(location).host;
    return memorySource({ files, buffer }, { fail: () => down.has(name), onRequest: () => log.push(name), verdicts: (verdicts[name] = []) });
  };
  return { locations, sourceFor, log, down, verdicts, names: () => locations.held().map((url) => new URL(url).host) };
}
