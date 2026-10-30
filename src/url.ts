// URL helpers every reader shares: untrusted locations checked and resolved,
// the directory a file location sits in, paths encoded for a request.

import { MAX_HINT_URL_BYTES } from './limits.ts';

const encoder = new TextEncoder();

// Resolve one untrusted location — a hints entry against its document's URL,
// a router's answer absolute — keeping it only if it is a string, resolves to
// an http(s) URL, and stays within the byte cap; strip a trailing slash so a
// directory hint composes like a configured base.
export function resolveLocation(raw: unknown, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (encoder.encode(url.href).length > MAX_HINT_URL_BYTES) return null;
  return url.href.replace(/\/+$/, '');
}

// The directory containing a file location — the probe anchor for locations
// that are files (a content file, a proof CAR). `new URL('.', u)` drops the
// last path segment and any query string, so the result is always a clean
// directory URL.
export function containingDir(url: string): string {
  return new URL('.', url).href;
}

// Percent-encode each path segment; the separators stay literal.
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
