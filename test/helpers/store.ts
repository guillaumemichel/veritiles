// Stores over fixed lists, as the built-in router would hand them over: the
// locations are the page's own, all there at once.

import { Locator, type Locations } from '../../src/locations.ts';
import { type ByteSource, VerifiedStore, type VerifyStats } from '../../src/verified-store.ts';

export function fixedLocations(urls: string[], cid = 'fixed'): Locations {
  const page = { open: () => ({ configured: urls, rest: (async function* () {})() }), consulted: () => [] };
  return new Locator(undefined, page).for(cid, { kind: 'content' });
}

// A store trying `sources` in order.
export function storeOf(sources: ByteSource[], opts: { maxCacheBytes?: number; stats?: VerifyStats } = {}): VerifiedStore {
  const locations = fixedLocations(sources.map((_, i) => String(i)));
  return new VerifiedStore({ locations, sourceFor: (location) => sources[Number(location)]! }, opts);
}
