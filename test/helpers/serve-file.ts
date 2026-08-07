// A dumb host for a VerifiedFile / VerifiedSource: a single-`Range` 206 on
// the archive URL, and plain GETs of the proof tree under the proof base
// (`{fileUrl}.proofs/{root,…}`). Records every request; hooks can tamper
// ranged bodies, tamper proof files by path, or force proof statuses.

import type { FetchFn } from '../../src/range-source.ts';

export interface FileHostHooks {
  /** Mutate a ranged body; return undefined to leave it unchanged. */
  tamperRange?: (bytes: Uint8Array, range: { start: number; end: number }) => Uint8Array | undefined;
  /** Mutate a proof body by proof-relative path ('root', '3f2a…', …). */
  tamperProof?: (path: string, bytes: Uint8Array) => Uint8Array | undefined;
  /** Force an HTTP status for a proof-relative path (or all when pathless). */
  proofStatus?: (path: string) => number | undefined;
  onRequest?: (url: string, headers?: Record<string, string>) => void;
}

export function servePackage(
  fileUrl: string,
  bytes: Uint8Array,
  proofs: Map<string, Uint8Array>,
  hooks: FileHostHooks = {},
  proofBase = `${fileUrl}.proofs`,
): { fetch: FetchFn; requests: string[] } {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
    (init as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted();
    requests.push(url);
    hooks.onRequest?.(url, headers);

    if (url.startsWith(`${proofBase}/`)) {
      const path = decodeURIComponent(url.slice(proofBase.length + 1));
      const status = hooks.proofStatus?.(path);
      if (status) return new Response('x', { status });
      let body = proofs.get(path);
      if (body === undefined) return new Response('nf', { status: 404 });
      if (hooks.tamperProof) body = hooks.tamperProof(path, body) ?? body;
      return new Response(new Uint8Array(body), { status: 200 });
    }
    const range = headers?.Range ?? headers?.range;
    if (url === fileUrl && range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, bytes.length);
      let slice = bytes.subarray(start, end);
      if (hooks.tamperRange) slice = hooks.tamperRange(slice, { start, end }) ?? slice;
      return new Response(new Uint8Array(slice), { status: 206 });
    }
    return new Response('not found', { status: 404 });
  }) as FetchFn;
  return { fetch, requests };
}
