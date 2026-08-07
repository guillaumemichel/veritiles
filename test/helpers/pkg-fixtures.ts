// Shared VerifiedFile fixtures: deterministic proof packages under pinned
// seeds + cut lists, built by helpers/package.ts (canonical importer map CID,
// canonical dag-cbor anchor).

import { deterministicBytes } from './bytes.ts';
import { buildProofPackage, type ProofPackage } from './package.ts';

const K = 262144;

// Depth 1: 20 leaves, one shard, embedded top meta.
export const buildPkgFlat = (): Promise<ProofPackage> =>
  buildProofPackage({
    mapBytes: deterministicBytes(20 * K, 40),
    cuts: Array.from({ length: 20 }, () => K),
  });

// Depth 3: 64 leaves forced into 2-record shards under 4-entry metas.
export const buildPkgDeep = (): Promise<ProofPackage> =>
  buildProofPackage({
    mapBytes: deterministicBytes(64 * 1024, 6),
    cuts: Array.from({ length: 64 }, () => 1024),
    shardCap: 72, // 2 records per shard
    metaMaxEntries: 4,
  });

// The degenerate one-leaf package.
export const buildPkgOne = (): Promise<ProofPackage> =>
  buildProofPackage({ mapBytes: deterministicBytes(1000, 1), cuts: [1000] });
