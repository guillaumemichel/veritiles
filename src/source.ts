// The pmtiles entry point: a PMTiles-compatible `Source` that is a thin adapter
// over a VerifiedFile. The archive is one file anchored to its own root CID
// (SPEC §2); all verification, failover, caching, and the read loop live in
// VerifiedFile. The pmtiles `Source` interface is implemented structurally — no
// import needed — so one class plugs into every renderer that speaks PMTiles:
//
//   MapLibre GL  protocol.add(new pmtiles.PMTiles(source))
//   Leaflet      leafletLayer({ url: new pmtiles.PMTiles(source) })       vector
//                pmtiles.leafletRasterLayer(new pmtiles.PMTiles(source))  raster
//   OpenLayers   new PMTilesVectorSource({ url: source })
//
// The host contract is GET + single-`Range` 206 over the archive file, and a
// plain GET for the proof CAR. Locations carry no trust: verification uses only
// the configured anchor CID, so a wrong or malicious host merely fails
// verification and the next source is tried.

import { VerifiedFile, type VerifiedFileOptions } from './verified-file.ts';
import type { VerifyStats } from './verified-store.ts';

// The pmtiles RangeResponse shape. etag/expires/cacheControl stay unset: the
// archive is content-addressed and immutable, so etag invalidation can never
// trigger — tampering is a verification failure, not a cache miss.
export interface RangeResponse {
  data: ArrayBuffer;
  etag?: string;
  expires?: string;
  cacheControl?: string;
}

export class VerifiedSource {
  #file: VerifiedFile;

  constructor(options: VerifiedFileOptions) {
    this.#file = new VerifiedFile(options);
  }

  // pmtiles.Protocol registers archives under this key: style URLs read
  // `pmtiles://<cid>`.
  getKey(): string {
    return this.#file.cid;
  }

  // Counts of hash checks passed / failed so far — one `rejected` means one
  // tampered or corrupted response was caught and discarded.
  get stats(): VerifyStats {
    return this.#file.stats;
  }

  // Open eagerly instead of on the first tile read — optional; surfaces a bad
  // CID or unreachable host before the map goes up.
  async ready(): Promise<void> {
    await this.#file.ready();
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
    const bytes = await this.#file.read(offset, length, { signal });
    // read() returns a freshly allocated, unshared, exactly-sized buffer, so
    // hand pmtiles its ArrayBuffer directly — no defensive copy.
    return { data: bytes.buffer as ArrayBuffer };
  }
}
