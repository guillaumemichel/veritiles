// anymirror/file: one large file, such as PMTiles or a video, read by byte
// ranges, each verified before it is handed over (SPEC §2).

export { VerifiedFile } from '../verified-file.ts';
export type { VerifiedFileOptions } from '../verified-file.ts';
export { RangeBlockedError, RangeUnsupportedError } from '../range-source.ts';
export { VerificationError } from '../verify.ts';
export type { VerifyStats } from '../verified-store.ts';
export type { FetchFn } from '../routing.ts';
export type { FetchContext, Router, RouterOption, Verdict } from '@anymirror/router';
