// The built-in router (SPEC §5, §6): a CID's locations from the page itself.
// Its configured locations (`source`, `proof`, and the names derived from
// them) come first and at once. Then, if the page turned hints on, what the
// hints plugin finds: the documents' locations, then the probes'. A custom
// router gets this stream as its `defaults`; where its own locations lead is
// its business.

import type { DefaultLocations } from './locations.ts';
import type { FetchFn } from './routing.ts';
import { encodePath, rootOf } from './url.ts';

/** What an anchor roots: a ranged file's proof tree, a raw file, or a MASL bundle. */
export type AnchorKind = 'ranged' | 'raw' | 'bundle';

/** Hints documents and discovery for the built-in router (SPEC §5): what `hints()` makes. */
export interface Hints {
  /** The page named its documents, consulted for every CID. */
  readonly explicit: boolean;
  /** The plugin for one client. */
  open(client: HintsClient): HintedLocations;
}

// What the built-in router tells the hints plugin of its client.
export interface HintsClient {
  anchor: string;
  kind: AnchorKind;
  sources: string[];
  /** The anchor's configured locations. */
  anchorLocations: string[];
  fetchFn: FetchFn;
}

// The hints plugin's locations for one client.
export interface HintedLocations {
  /** The client asks for a CID's locations. */
  opened(): void;
  /** The CID's locations after its configured ones. */
  rest(cid: string, configured: boolean): AsyncIterable<string>;
  /** The documents fetched so far, for the error naming an unlocated CID. */
  consulted(): string[];
}

export interface DefaultRouterOptions {
  /** The client's anchor, canonical text. */
  anchor: string;
  kind: AnchorKind;
  /** Configured URLs of the file (ranged, raw) or bases of the bundle. */
  sources: string[];
  /** Configured proof locations: proof bases (ranged) or proof CARs and blocks (bundle). */
  proof: string | string[] | undefined;
  /** The hints plugin, if the page turned hints on. */
  hints: Hints | undefined;
  fetchFn: FetchFn;
}

export class DefaultRouter implements DefaultLocations {
  #anchor: string;
  #kind: AnchorKind;
  #sources: string[];
  #anchorLocations: string[];
  #hinted: HintedLocations | undefined;

  constructor({ anchor, kind, sources, proof, hints, fetchFn }: DefaultRouterOptions) {
    if (hints !== undefined && typeof (hints as Partial<Hints> | null)?.open !== 'function') {
      throw new Error('hints must be the plugin hints() makes');
    }
    this.#anchor = anchor;
    this.#kind = kind;
    this.#sources = sources;
    this.#anchorLocations = this.#configuredAnchor(proof, hints?.explicit ?? false);
    this.#hinted = hints?.open({ anchor, kind, sources, anchorLocations: this.#anchorLocations, fetchFn });
  }

  open(cid: string, path = ''): { configured: string[]; rest: AsyncIterable<string> } {
    this.#hinted?.opened();
    const configured = cid === this.#anchor ? this.#anchorLocations : this.#configuredFile(path);
    return { configured, rest: this.#hinted?.rest(cid, configured.length > 0) ?? none() };
  }

  consulted(): string[] {
    return this.#hinted?.consulted() ?? [];
  }

  // The anchor's configured locations: explicit `proof`, else derived from
  // each source — `{source}.proofs/root` for a ranged file, `{base}.car` for
  // a bundle; a raw file's are its sources. A query-string source derives no
  // clean name: an explicit proof is required, unless explicit hints defer
  // the question to the documents.
  #configuredAnchor(proof: string | string[] | undefined, explicitHints: boolean): string[] {
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
      if (explicitHints) return [];
      throw new Error(`source ${bad} has a query string; an explicit proof URL is required`);
    }
    return dedupe(this.#sources.map((source) => (this.#kind === 'ranged' ? `${source}.proofs/root` : `${source}.car`)));
  }

  // A file the anchor names: a ranged file's map at each source, a bundle
  // file at each base under its path.
  #configuredFile(path: string): string[] {
    return this.#kind === 'bundle' ? this.#sources.map((base) => `${base}/${encodePath(path)}`) : this.#sources;
  }
}

async function* none(): AsyncGenerator<string> {}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
