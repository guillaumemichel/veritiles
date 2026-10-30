// Routing hints (SPEC §5): a mutable, untrusted JSON document mapping CIDs
// to candidate locations. It lives OUTSIDE the root of trust — every byte
// fetched through a hint is verified against the anchor chain exactly as a
// configured URL is — so parsing is deliberately tolerant: salvage every valid
// entry, ignore the rest, and never throw a VerificationError. Only a
// non-object body or the size cap rejects a whole document. A page turns
// hints on with the plugin `hints()`.

import { cidToText, tryParseCid } from './cid.ts';
import type { AnchorKind, HintedLocations, Hints, HintsClient } from './default-router.ts';
import { MAX_HINT_BYTES, MAX_HINT_DOCS, MAX_HINT_URLS_PER_CID } from './limits.ts';
import { readBody } from './read-body.ts';
import type { FetchFn } from './routing.ts';
import { containingDir, resolveLocation, rootOf } from './url.ts';

const DEFAULT_HINTS_URL = './hints.json';
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
      const url = resolveLocation(element, docUrl);
      if (url !== null) urls.push(url);
    }
    if (urls.length > 0) out.set(cidToText(cid), urls);
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface HintResolverOptions {
  /** Explicit document URL(s); the default (`./hints.json`) applies when absent. */
  hints?: string | string[];
  fetchFn: FetchFn;
}

// Lazy, memoized resolver over one or more hints documents. Fetches nothing
// until a location is actually needed; memoizes each document's parsed entries
// on success only (a fetch or parse failure stays retryable); shares a
// document's fetch among concurrent readers; merges matches in document order,
// configured-then-probed, first-URL-wins, capped per CID.
export class HintResolver {
  #fetchFn: FetchFn;
  #docUrls: string[] = [];
  #docs = new Map<string, Map<string, string[]>>(); // docUrl -> parsed entries (successes only)
  #fetching = new Map<string, Promise<void>>(); // docUrl -> fetch in flight
  #attempted = new Set<string>(); // docUrls fetched at least once, in order

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
  async urlsFor(cid: string): Promise<string[]> {
    await this.load();
    return this.known(cid);
  }

  // The same from the documents read so far, fetching nothing.
  known(cid: string): string[] {
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

  // Fetch every known document not read yet.
  async load(): Promise<void> {
    for (const docUrl of this.#docUrls) await this.#fetchDoc(docUrl);
  }

  // Fetch a directory location's in-directory document, `{dir}/hints.json`
  // (SPEC §5). Its entries then merge on the next urlsFor. Skips past
  // the per-client document cap.
  async probe(dirUrl: string): Promise<void> {
    const docUrl = `${dirUrl.replace(/\/+$/, '')}/hints.json`;
    if (!this.#addDoc(docUrl)) return;
    await this.#fetchDoc(docUrl);
  }

  // The documents fetched so far, in order — for the error naming what was
  // consulted when a CID stays unlocated.
  consulted(): string[] {
    return [...this.#attempted];
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

  #fetchDoc(docUrl: string): Promise<void> {
    if (this.#docs.has(docUrl)) return Promise.resolve(); // memoized success
    let fetching = this.#fetching.get(docUrl);
    if (fetching === undefined) {
      this.#attempted.add(docUrl);
      fetching = this.#readDoc(docUrl).finally(() => this.#fetching.delete(docUrl));
      this.#fetching.set(docUrl, fetching);
    }
    return fetching;
  }

  async #readDoc(docUrl: string): Promise<void> {
    let text: string;
    let baseUrl = docUrl;
    try {
      const res = await this.#fetchFn(docUrl);
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

// The hints plugin: hints documents and discovery for the built-in router,
// the documents `urls` names or, without, `./hints.json` beside the page.
// After a CID's configured locations come the documents': an explicit
// document is always consulted, fetched in the background from the first
// open on; the default one only for a CID with nothing configured. Then, for
// a CID still without a location, documents probed beside the page's own
// locations: the anchor's beside its sources, any other CID's beside the
// anchor's.
export function hints(urls?: string | string[]): Hints {
  return { explicit: urls !== undefined, open: (client) => new HintedRouter(urls, client) };
}

// The plugin for one client.
class HintedRouter implements HintedLocations {
  #anchor: string;
  #kind: AnchorKind;
  #sources: string[];
  #anchorLocations: string[];
  #explicit: boolean;
  #resolver: HintResolver;

  constructor(urls: string | string[] | undefined, { anchor, kind, sources, anchorLocations, fetchFn }: HintsClient) {
    this.#anchor = anchor;
    this.#kind = kind;
    this.#sources = sources;
    this.#anchorLocations = anchorLocations;
    this.#explicit = urls !== undefined;
    this.#resolver = new HintResolver({ hints: urls, fetchFn });
  }

  // A microtask later, so the requests to configured locations leave first.
  opened(): void {
    if (this.#explicit) queueMicrotask(() => void this.#resolver.load());
  }

  consulted(): string[] {
    return this.#resolver.consulted();
  }

  // After the configured locations: the documents' — explicit ones always,
  // the default one only when nothing is configured — then, still nothing,
  // the probes'.
  async *rest(cid: string, configured: boolean): AsyncGenerator<string> {
    const hinted = this.#explicit || !configured ? await this.#hinted(cid) : [];
    yield* hinted;
    if (configured || hinted.length) return;
    yield* await this.#probe(cid);
  }

  async #hinted(cid: string): Promise<string[]> {
    return this.#asLocations(cid, await this.#resolver.urlsFor(cid));
  }

  // Hinted URLs as a CID's locations. A ranged file's anchor is hinted by its
  // proof base, whose `{u}/root` locates its bytes; a base with a query
  // string has no clean `/root` and is dropped.
  #asLocations(cid: string, urls: string[]): string[] {
    if (cid !== this.#anchor || this.#kind !== 'ranged') return urls;
    return urls.filter((url) => !url.includes('?')).map(rootOf);
  }

  // SPEC §5 discovery. The anchor probes beside each source: its containing
  // directory may hold a document naming the proofs. Any other CID probes
  // beside the anchor's configured and hinted locations, newly hinted ones
  // included, until it is found or the directories run out. A raw file has
  // nothing to probe beside.
  async #probe(cid: string): Promise<string[]> {
    if (cid === this.#anchor) {
      if (!this.#sources.length) return [];
      for (const source of this.#sources) await this.#resolver.probe(containingDir(source));
      return this.#asLocations(cid, this.#resolver.known(cid));
    }
    const probed = new Set<string>();
    for (;;) {
      const anchorLocations = [...new Set([...this.#anchorLocations, ...this.#asLocations(this.#anchor, this.#resolver.known(this.#anchor))])];
      const dirs = anchorLocations.map((location) => this.#besideAnchor(location)).filter((dir) => !probed.has(dir));
      if (!dirs.length) return [];
      for (const dir of dirs) {
        probed.add(dir);
        await this.#resolver.probe(dir);
      }
      const urls = this.#resolver.known(cid);
      if (urls.length) return urls;
    }
  }

  // The directory beside an anchor location: a ranged file's proof base (the
  // directory `{proof}/root` sits in), a bundle proof file's containing one.
  #besideAnchor(location: string): string {
    return this.#kind === 'ranged' ? location.slice(0, -'/root'.length) : containingDir(location);
  }
}
