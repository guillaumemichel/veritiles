// The built-in router (SPEC §5, §6): a CID's locations from the page itself.
// Its configured locations (`source`, `proof`, and the names derived from
// them) come first and at once. Then the hints documents': an explicit
// document is always consulted, fetched in the background from the first
// open on; the default `./hints.json` only for a CID with nothing
// configured. Then, for a CID still without a location, documents probed
// beside the page's own locations: the anchor's beside its sources, any other
// CID's beside the anchor's. A custom router gets this stream as its
// `defaults`; where its own locations lead is its business.

import { containingDir, HintResolver } from './hints.ts';
import type { DefaultLocations } from './locations.ts';
import { encodePath, type FetchFn } from './range-source.ts';

export interface DefaultRouterOptions {
  /** The client's anchor, canonical text. */
  anchor: string;
  /** What the anchor roots: a ranged file's proof tree, a raw file, or a MASL bundle. */
  kind: 'ranged' | 'raw' | 'bundle';
  /** Configured URLs of the file (ranged, raw) or bases of the bundle. */
  sources: string[];
  /** Configured proof locations: proof bases (ranged) or proof CARs and blocks (bundle). */
  proof: string | string[] | undefined;
  /** Explicit hints document URL(s); the default `./hints.json` otherwise. */
  hints: string | string[] | undefined;
  fetchFn: FetchFn;
}

export class DefaultRouter implements DefaultLocations {
  #anchor: string;
  #kind: DefaultRouterOptions['kind'];
  #sources: string[];
  #explicit: boolean;
  #anchorLocations: string[];
  #resolver: HintResolver;

  constructor({ anchor, kind, sources, proof, hints, fetchFn }: DefaultRouterOptions) {
    this.#anchor = anchor;
    this.#kind = kind;
    this.#sources = sources;
    this.#explicit = hints !== undefined;
    this.#anchorLocations = this.#configuredAnchor(proof);
    this.#resolver = new HintResolver({ hints, fetchFn });
  }

  open(cid: string, path = ''): { configured: string[]; rest: AsyncIterable<string> } {
    // A microtask later, so the requests to configured locations leave first.
    if (this.#explicit) queueMicrotask(() => void this.#resolver.load());
    const configured = cid === this.#anchor ? this.#anchorLocations : this.#configuredFile(path);
    return { configured, rest: this.#rest(cid, configured.length > 0) };
  }

  consulted(): string[] {
    return this.#resolver.consulted();
  }

  // The anchor's configured locations: explicit `proof`, else derived from
  // each source — `{source}.proofs/root` for a ranged file, `{base}.car` for
  // a bundle; a raw file's are its sources. A query-string source derives no
  // clean name: an explicit proof is required, unless explicit hints defer
  // the question to the documents.
  #configuredAnchor(proof: string | string[] | undefined): string[] {
    if (this.#kind === 'raw') return this.#sources;
    if (proof !== undefined) {
      const urls = Array.isArray(proof) ? proof : [proof];
      if (!urls.length || urls.some((url) => typeof url !== 'string' || !url.length)) {
        throw new Error('proof must be a URL or a non-empty list of URLs');
      }
      return dedupe(this.#kind === 'ranged' ? urls.map(rootOf) : urls);
    }
    const bad = this.#sources.find((source) => source.includes('?'));
    if (bad !== undefined) {
      if (this.#explicit) return [];
      throw new Error(`source ${bad} has a query string; an explicit proof URL is required`);
    }
    return dedupe(this.#sources.map((source) => (this.#kind === 'ranged' ? `${source}.proofs/root` : `${source}.car`)));
  }

  // A file the anchor names: a ranged file's map at each source, a bundle
  // file at each base under its path.
  #configuredFile(path: string): string[] {
    return this.#kind === 'bundle' ? this.#sources.map((base) => `${base}/${encodePath(path)}`) : this.#sources;
  }

  // After the configured locations: the documents' — explicit ones always,
  // the default one only when nothing is configured — then, still nothing,
  // the probes'.
  async *#rest(cid: string, configured: boolean): AsyncGenerator<string> {
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
      const anchorLocations = dedupe([...this.#anchorLocations, ...this.#asLocations(this.#anchor, this.#resolver.known(this.#anchor))]);
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

const rootOf = (base: string) => `${base.replace(/\/+$/, '')}/root`;

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
