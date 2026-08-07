import { buildArtifact, type Artifact, type TreeEntry } from './artifact.ts';
import { deterministicBytes } from './bytes.ts';

export const TREE_ENTRIES: TreeEntry[] = [
  { path: 'style.json', bytes: deterministicBytes(200, 11), contentType: 'application/json' },
  { path: 'Noto Sans Regular/0-255.pbf', bytes: deterministicBytes(2048, 12), contentType: 'application/x-protobuf' },
  { path: 'fonts é/z.pbf', bytes: deterministicBytes(1024, 13) },
];

export const buildRaw = (): Promise<Artifact> => buildArtifact(deterministicBytes(1000, 1));
export const buildRawEmpty = (): Promise<Artifact> => buildArtifact(new Uint8Array(0));
export const buildTree = (): Promise<Artifact> => buildArtifact(TREE_ENTRIES);
