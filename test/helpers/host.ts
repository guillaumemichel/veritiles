// In-memory "dumb host": plain GET + single Range, nothing else — the whole
// host contract the library targets. `files` maps package-relative paths
// (e.g. 'map.pmtiles', 'proofs/meta') to bytes; the /ipfs/<rootCid>/ prefix
// a VerifiedSource composes into its URLs is stripped before lookup.
// tamper(path, range, bytes) may replace a response body — `range` is null
// for a plain GET, so a test can corrupt only ranged (tile) responses.

export interface HostRange {
  start: number;
  end: number;
}

export interface HostOptions {
  tamper?: (path: string, range: HostRange | null, bytes: Uint8Array) => Uint8Array | undefined;
  onRequest?: (url: string, headers?: Record<string, string>) => void;
}

export function rangeFetch(files: Map<string, Uint8Array>, { tamper, onRequest }: HostOptions = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { headers, signal } = (init ?? {}) as {
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };
    signal?.throwIfAborted();
    onRequest?.(String(url), headers);
    const rel = new URL(String(url), 'http://host/').pathname.replace(/^\/+/, '');
    const decoded = rel.split('/').map(decodeURIComponent).join('/');
    const path = decoded.replace(/^(?:.*?\/)?ipfs\/[a-z2-7]+\//, '');
    const bytes = files.get(path);
    if (bytes === undefined) return new Response('not found', { status: 404 });

    const value = headers?.Range ?? headers?.range;
    const match = value && /^bytes=(\d+)-(\d+)$/.exec(value);
    if (!match) {
      const body = tamper ? (tamper(path, null, bytes) ?? bytes) : bytes;
      return new Response(new Uint8Array(body), { status: 200 });
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, bytes.length);
    let slice = bytes.subarray(start, end);
    if (tamper) slice = tamper(path, { start, end }, slice) ?? slice;
    return new Response(new Uint8Array(slice), { status: 206 });
  }) as typeof fetch;
}
