// veritiles: verified maps. Its readers are @anymirror/core's, with hints on by
// default (SPEC §5), plus the map adapters: a PMTiles source and a MapLibre
// protocol for verified assets.

export { VerifiedFile } from './hinted-file.ts';
export type { VerifiedFileOptions } from './hinted-file.ts';
export { VerifiedSource } from './source.ts';
export type { RangeResponse } from './source.ts';
export { VerifiedAsset } from './asset.ts';
export type { VerifiedAssetOptions } from './asset.ts';
export { assetProtocol } from './asset-protocol.ts';
export { NotFoundError, RangeBlockedError, RangeUnsupportedError, VerificationError } from '@anymirror/core';
export type { AssetStat, FetchContext, ManifestEntry, Router, RouterOption, Verdict, VerifyStats } from '@anymirror/core';
