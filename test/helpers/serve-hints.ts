// One routed fetch over package hosts (servePackage), hints documents (JSON
// bodies at their URL), and whole-file URLs (a hinted src/content location
// serving one file at path ''). The returned `requests` array records every
// top-level request URL in order — request accounting is first-class in the
// hints suites, so "no request happened" is an assertion.

import type { FetchFn } from '../../src/range-source.ts';
import { servePackage, type FileHostHooks } from './serve-file.ts';

// Run fn with globalThis.location set to href — the environment base the hint
// resolver reads at construction (the default `./hints.json` resolves against
// it). Node has no location, and tests within a file run sequentially, so a
// scoped set/restore is race-free.
export async function withPageUrl<T>(href: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { location?: { href: string } };
  g.location = { href };
  try {
    return await fn();
  } finally {
    delete g.location;
  }
}

export interface HintHost {
  fileUrl: string;
  bytes: Uint8Array;
  proofs?: Map<string, Uint8Array>;
  hooks?: FileHostHooks;
  /** Proof base override (default `${fileUrl}.proofs`) — for query-string file URLs. */
  proofBase?: string;
}

export function scene(
  hosts: HintHost[],
  docs: Record<string, unknown>,
  whole: Record<string, Uint8Array> = {},
): { fetchFn: FetchFn; requests: string[] } {
  const routed = hosts.map((h) => servePackage(h.fileUrl, h.bytes, h.proofs ?? new Map(), h.hooks, h.proofBase));
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    (init as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted();
    requests.push(url);
    if (Object.prototype.hasOwnProperty.call(docs, url)) {
      return new Response(JSON.stringify({ hints: docs[url] }), { status: 200 });
    }
    if (Object.prototype.hasOwnProperty.call(whole, url)) {
      return new Response(new Uint8Array(whole[url]!), { status: 200 });
    }
    for (const r of routed) {
      const res = await r.fetch(url, init);
      if (res.status !== 404) return res;
    }
    return new Response('nf', { status: 404 });
  }) as FetchFn;
  return { fetchFn, requests };
}
