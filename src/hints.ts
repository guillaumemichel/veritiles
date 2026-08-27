// Routing hints (SPEC §5): a mutable, untrusted JSON document mapping CIDs
// to candidate locations. It lives OUTSIDE the root of trust — every byte
// fetched through a hint is verified against the anchor chain exactly as a
// configured URL is — so parsing is deliberately tolerant: salvage every valid
// entry, ignore the rest, and never throw a VerificationError. Only a
// non-object body or the size cap rejects a whole document.

import { cidToText, tryParseCid } from './cid.ts';
import { MAX_HINT_BYTES, MAX_HINT_DOCS, MAX_HINT_URL_BYTES, MAX_HINT_URLS_PER_CID } from './limits.ts';
import type { FetchFn } from './range-source.ts';
import { readBody } from './read-body.ts';

const DEFAULT_HINTS_URL = './hints.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Parse one hints document against its own URL. Returns a CID-text → URL-list
// map (salvaged per SPEC §5), or null when the body is not a JSON
// object. A valid object with no usable `hints` yields an empty map — the
// document was consulted, it just named nothing.
export function parseHintsDocument(text: string, docUrl: string): Map<string, string[]> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(doc)) return null;
  const out = new Map<string, string[]>();
  if (!isObject(doc.hints)) return out;
  for (const [key, value] of Object.entries(doc.hints)) {
    const cid = tryParseCid(key);
    if (cid === null || !Array.isArray(value)) continue;
    const urls: string[] = [];
    for (const element of value) {
      const url = resolveHintUrl(element, docUrl);
      if (url !== null) urls.push(url);
    }
    if (urls.length > 0) out.set(cidToText(cid), urls);
  }
  return out;
}

// Resolve one array element against the document URL, keep it only if it is a
// string, resolves to an http(s) URL, and stays within the byte cap; strip a
// trailing slash so a directory hint composes like a configured base.
function resolveHintUrl(raw: unknown, docUrl: string): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw, docUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (encoder.encode(url.href).length > MAX_HINT_URL_BYTES) return null;
  return url.href.replace(/\/+$/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The directory containing a file location — the probe anchor for locations
// that are files (a content file, a proof CAR). `new URL('.', u)` drops the
// last path segment and any query string, so the result is always a clean
// directory URL.
export function containingDir(url: string): string {
  return new URL('.', url).href;
}

export interface HintResolverOptions {
  /** Explicit document URL(s); the default (`./hints.json`) applies when absent. */
  hints?: string | string[];
  fetchFn: FetchFn;
}

// Lazy, memoized resolver over one or more hints documents. Fetches nothing
// until a location is actually needed; memoizes each document's parsed entries
// on success only (a fetch or parse failure stays retryable); merges matches in
// document order, configured-then-probed, first-URL-wins, capped per CID.
export class HintResolver {
  #fetchFn: FetchFn;
  #docUrls: string[] = [];
  #docs = new Map<string, Map<string, string[]>>(); // docUrl -> parsed entries (successes only)

  constructor({ hints, fetchFn }: HintResolverOptions) {
    this.#fetchFn = fetchFn;
    const explicit = hints !== undefined;
    const specs = hints === undefined ? [DEFAULT_HINTS_URL] : Array.isArray(hints) ? hints : [hints];
    if (explicit && (specs.length === 0 || specs.some((s) => typeof s !== 'string' || s.length === 0))) {
      throw new Error('hints must be a URL or a non-empty list of URLs');
    }
    // The environment base — what a relative fetch from the embedding page
    // would use. Node has neither, so the defaulted document is absent there
    // and an explicit relative URL throws (an authoring error).
    const base = globalThis.document?.baseURI ?? globalThis.location?.href;
    for (const spec of specs) {
      const resolved = resolveDocUrl(spec, base, explicit);
      if (resolved === null) continue;
      // Silently dropping a configured document would hide an authoring error;
      // only probes skip past the cap (SPEC §5 limits).
      if (!this.#addDoc(resolved)) throw new Error(`hints names more than ${MAX_HINT_DOCS} documents`);
    }
  }

  // Merged hinted URLs for one CID (canonical text), fetching any not-yet-read
  // documents first. Never throws for the hints layer: a missing or malformed
  // document simply contributes nothing.
  async urlsFor(cid: string, { signal }: { signal?: AbortSignal } = {}): Promise<string[]> {
    for (const docUrl of this.#docUrls) await this.#fetchDoc(docUrl, signal);
    return this.#merge(cid);
  }

  // Fetch a directory location's in-directory document, `{dir}/hints.json`
  // (SPEC §5). Its entries then merge on the next urlsFor. Skips past
  // the per-client document cap.
  async probe(dirUrl: string, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const docUrl = `${dirUrl.replace(/\/+$/, '')}/hints.json`;
    if (!this.#addDoc(docUrl)) return;
    await this.#fetchDoc(docUrl, signal);
  }

  // The documents this resolver knows about — for the error naming what was
  // consulted when a CID stays unlocated.
  consulted(): string[] {
    return [...this.#docUrls];
  }

  // Register a document URL if new and under the cap. Returns false only when
  // the cap is reached for a genuinely new URL (probes skip); an already-known
  // URL returns true so a re-probe re-fetches a previously-failed document.
  #addDoc(docUrl: string): boolean {
    if (this.#docUrls.includes(docUrl)) return true;
    if (this.#docUrls.length >= MAX_HINT_DOCS) return false;
    this.#docUrls.push(docUrl);
    return true;
  }

  async #fetchDoc(docUrl: string, signal: AbortSignal | undefined): Promise<void> {
    if (this.#docs.has(docUrl)) return; // memoized success
    let text: string;
    let baseUrl = docUrl;
    try {
      const res = await this.#fetchFn(docUrl, { signal });
      if (!res.ok) {
        void res.body?.cancel?.();
        return;
      }
      // The document's own URL is the final one after redirects (SPEC §5): a
      // redirecting mirror hands out its own base. A synthetic Response
      // reports '', which keeps the requested URL.
      if (res.url) baseUrl = res.url;
      text = decoder.decode(await readBody(res, MAX_HINT_BYTES));
    } catch {
      return; // transport / oversize failure: retryable, never memoized
    }
    const parsed = parseHintsDocument(text, baseUrl);
    if (parsed !== null) this.#docs.set(docUrl, parsed);
  }

  #merge(cid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const docUrl of this.#docUrls) {
      for (const url of this.#docs.get(docUrl)?.get(cid) ?? []) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= MAX_HINT_URLS_PER_CID) return out;
      }
    }
    return out;
  }
}

// Resolve a configured document spec to an absolute URL. An absolute spec
// ignores the base; a relative spec needs one — absent it, an explicit spec is
// an authoring error (throw), while the defaulted `./hints.json` is silently
// absent.
function resolveDocUrl(spec: string, base: string | undefined, explicit: boolean): string | null {
  try {
    return new URL(spec, base).href;
  } catch {
    if (explicit) throw new Error(`hints URL '${spec}' is relative but no base URL is available`);
    return null;
  }
}
