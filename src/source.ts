// The public entry point: a pmtiles-compatible `Source` anchored to one
// root CID over one or more untrusted hosts. Construction is synchronous;
// the first read bootstraps trust (metadata.json → root CID reconstruction)
// and a failed bootstrap stays retryable. The pmtiles `Source` interface is
// implemented structurally — no import needed — so one class plugs into
// every renderer that speaks PMTiles:
//
//   MapLibre GL  protocol.add(new pmtiles.PMTiles(source))
//   Leaflet      leafletLayer({ url: new pmtiles.PMTiles(source) })       vector
//                pmtiles.leafletRasterLayer(new pmtiles.PMTiles(source))  raster
//   OpenLayers   new PMTilesVectorSource({ url: source })
//
// The host contract is GET + single-`Range` 206 over the published package
// directory: `<base>/{metadata.json, map.pmtiles, proofs/…}` where `base`
// is any URL — a static host path, an S3 bucket, a range-capable IPFS
// gateway path like `https://gateway.example/ipfs/<rootCid>`. The URL
// carries no trust: verification uses only the configured rootCid, so a
// wrong or malicious base merely fails verification and the next source
// is tried.

import { assertRootCid, openMapManifest } from './bootstrap.ts';
import { MapFile } from './map-file.ts';
import { ProofIndex } from './proof-index.ts';
import { type FetchFn, RangeSource } from './range-source.ts';
import { VerifiedStore, type VerifyStats } from './verified-store.ts';

// The pmtiles RangeResponse shape. etag/expires/cacheControl stay unset:
// the archive is content-addressed and immutable, so etag invalidation can
// never trigger — tampering is a verification failure, not a cache miss.
export interface RangeResponse {
  data: ArrayBuffer;
  etag?: string;
  expires?: string;
  cacheControl?: string;
}

export interface VerifiedSourceOptions {
  /** Root CID of the map package — the only trust anchor. */
  rootCid: string;
  /**
   * Base URL(s) of the published package — the directory containing
   * metadata.json — tried in order. Any URL shape works: a static host
   * path (`https://tiles.example/world`), an IPFS gateway path
   * (`https://dweb.link/ipfs/<rootCid>`), or a page-relative path.
   */
  source: string | string[];
  /** Replaces global fetch — instrumentation and test seam. */
  fetchFn?: FetchFn;
  /** Budget for the verified-byte LRU cache (default 64 MiB). */
  maxCacheBytes?: number;
}

export class VerifiedSource {
  #rootCid: string;
  #store: VerifiedStore;
  #map: Promise<MapFile> | undefined;

  constructor(options: VerifiedSourceOptions) {
    const { rootCid, source, fetchFn, maxCacheBytes } = options;
    assertRootCid(rootCid);
    const bases = Array.isArray(source) ? source : [source];
    if (bases.length === 0 || bases.some((b) => typeof b !== 'string')) {
      throw new Error('source must be a base URL or a non-empty list of base URLs');
    }
    this.#rootCid = rootCid;
    this.#store = new VerifiedStore(
      bases.map((base) => new RangeSource(base, { fetchFn })),
      { maxCacheBytes },
    );
  }

  // pmtiles.Protocol registers archives under this key: style URLs read
  // `pmtiles://<rootCid>`.
  getKey(): string {
    return this.#rootCid;
  }

  // Counts of hash checks passed / failed so far — one `rejected` means one
  // tampered or corrupted response was caught and discarded.
  get stats(): VerifyStats {
    return this.#store.stats;
  }

  // Bootstrap eagerly instead of on the first tile read — optional; useful
  // to surface a bad CID or unreachable host before the map goes up.
  async ready(): Promise<void> {
    await this.#open();
  }

  // The pmtiles Source read: verified bytes for [offset, offset + length),
  // clamped to EOF (the pmtiles header probe reads 16 KiB unconditionally,
  // which may exceed a small archive).
  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    _etag?: string,
  ): Promise<RangeResponse> {
    const map = await this.#open();
    const bytes = await map.read(offset, length, { signal });
    // read() returns a freshly allocated, unshared, exactly-sized buffer,
    // so hand pmtiles its ArrayBuffer directly — no defensive copy.
    return { data: bytes.buffer as ArrayBuffer };
  }

  // Lazy memoized bootstrap: the manifest fetch + root reconstruction runs
  // once, shared by every concurrent read. Deliberately not tied to any
  // caller's abort signal (it is one small fetch every consumer needs);
  // a failure clears the memo so the next read retries.
  #open(): Promise<MapFile> {
    if (this.#map === undefined) {
      this.#map = (async () => {
        const manifest = await openMapManifest(this.#rootCid, this.#store);
        const proofs = new ProofIndex(this.#store, {
          dir: manifest.proofsDir,
          metaDigest: manifest.proofsMetaDigest,
          fileSize: manifest.mapSize,
        });
        return new MapFile(this.#store, proofs, manifest.mapFile, manifest.mapSize);
      })();
      this.#map.catch(() => {
        this.#map = undefined;
      });
    }
    return this.#map;
  }
}
