// veritiles' VerifiedAsset: a raw file or a MASL bundle, whichever its
// anchor roots, read by a VerifiedRaw or a VerifiedBundle with hints on by
// default (SPEC §5), their documents named by URL, as veritiles has always
// read assets. A raw file reads at the empty path alone and declares no
// size.

import {
  type AssetStat,
  assetKind,
  type FetchFn,
  hints,
  type RouterOption,
  VerificationError,
  VerifiedBundle,
  VerifiedRaw,
  type VerifyStats,
} from '@anymirror/core';

export interface VerifiedAssetOptions {
  /** Content anchor: raw for one file or dag-cbor for a MASL bundle. */
  cid: string;
  /** Base URL(s) of the artifact, tried in order. Optional: hints or a router may supply them. */
  source?: string | string[];
  proof?: string | string[];
  /** Routing-hints document URL(s), untrusted (SPEC §5); defaults to `./hints.json`. */
  hints?: string | string[];
  /** Router, untrusted (SPEC §6): replaces the built-in one, which it gets as `defaults`, and may carry every request. */
  router?: RouterOption;
  fetchFn?: FetchFn;
  maxCacheBytes?: number;
  maxProofBytes?: number;
  maxFileBytes?: number;
}

export class VerifiedAsset {
  #asset: VerifiedRaw | VerifiedBundle;

  constructor(options: VerifiedAssetOptions) {
    const hinted = { ...options, hints: hints(options.hints) };
    if (assetKind(options.cid) === 'bundle') {
      this.#asset = new VerifiedBundle(hinted);
      return;
    }
    if (options.proof !== undefined) throw new Error('proof is not valid for a raw anchor');
    this.#asset = new VerifiedRaw(hinted);
  }

  get cid(): string {
    return this.#asset.cid;
  }

  get stats(): VerifyStats {
    return this.#asset.stats;
  }

  async bytes(path = '', { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (this.#asset instanceof VerifiedBundle) return this.#asset.bytes(path, { signal });
    signal?.throwIfAborted();
    if (path !== '') throw new VerificationError('raw artifact has no sub-paths');
    return this.#asset.bytes({ signal });
  }

  async stat(path = ''): Promise<AssetStat> {
    if (this.#asset instanceof VerifiedBundle) return this.#asset.stat(path);
    if (path !== '') throw new VerificationError('raw artifact has no sub-paths');
    throw new VerificationError('raw artifact has no declared size');
  }
}
