// Bootstrap trust from a single root CID and a dumb host. metadata.json is
// the only unverified fetch the client ever makes: its bytes are hashed, the
// root directory node is rebuilt from the manifest's children plus that
// self-computed link, and the result must equal the configured root CID.
// After that, every value in the manifest is authenticated.
//
// The root node itself cannot be a file inside its own directory (its bytes
// would have to contain their own hash), which is exactly why the manifest
// lists `{name, cid, tsize}` for every root child EXCEPT metadata.json: the
// client supplies that one link itself from the bytes it fetched.

import {
  type Cid,
  DAG_PB_CODE,
  formatCidV1,
  parseCid,
  rawLeafCidBytes,
  SHA2_256_CODE,
} from './cid.ts';
import { encodeDirNode } from './dag-pb.ts';
import { DIGEST_HEX_RE, equalBytes, sha256, VerificationError } from './verify.ts';

const FORMAT_VERSION = 2;
const METADATA_NAME = 'metadata.json';
const METADATA_CAP = 1024 * 1024;
const MAX_CHILDREN = 64;

export interface ManifestChild {
  name: string;
  cid: Cid;
  tsize: number;
}

export interface MapManifest {
  mapFile: string;
  mapSize: number;
  proofsDir: string;
  proofsMetaDigest: string;
  children: ManifestChild[];
}

// The one store capability bootstrap needs; the caller authenticates the
// returned bytes afterwards by reconstructing the root CID from them.
interface ManifestStore {
  fetchUnverified(path: string, cap: number, opts?: { signal?: AbortSignal }): Promise<Uint8Array>;
}

// The trust anchor must be the CID of a dag-pb directory node hashed with
// sha2-256 — the only root shape the reconstruction can produce.
export function assertRootCid(rootCidText: string): Cid {
  const rootCid = parseCid(rootCidText, 'root');
  if (
    rootCid.codec !== DAG_PB_CODE ||
    rootCid.hashCode !== SHA2_256_CODE ||
    rootCid.digest.length !== 32
  ) {
    throw new VerificationError('root CID must be dag-pb with sha2-256');
  }
  return rootCid;
}

export async function openMapManifest(
  rootCidText: string,
  store: ManifestStore,
  { signal }: { signal?: AbortSignal } = {},
): Promise<MapManifest> {
  const rootCid = assertRootCid(rootCidText);

  const bytes = await store.fetchUnverified(METADATA_NAME, METADATA_CAP, { signal });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new VerificationError('metadata.json: not valid UTF-8 JSON');
  }
  if (raw?.formatVersion !== FORMAT_VERSION) {
    throw new VerificationError(
      `metadata.json: unsupported formatVersion ${raw?.formatVersion}`,
    );
  }
  if (raw.hash !== 'sha2-256') {
    throw new VerificationError(`metadata.json: unsupported hash ${raw.hash}`);
  }
  const children = parseChildren(raw.children);
  const manifest = parseMapSection(raw, children);

  await reconstructRoot(rootCidText, rootCid, bytes, children);
  return { ...manifest, children };
}

// The reconstruction: hash the fetched manifest bytes into the self link,
// rebuild the canonical UnixFS directory node from `children` + that link,
// and require its digest to equal the trust anchor's. A second preimage on
// sha2-256 is the only way a tampered manifest passes.
async function reconstructRoot(
  rootCidText: string,
  rootCid: Cid,
  bytes: Uint8Array,
  children: ManifestChild[],
): Promise<void> {
  const links = [
    ...children.map((c) => ({ name: c.name, cidBytes: c.cid.bytes, tsize: c.tsize })),
    { name: METADATA_NAME, cidBytes: rawLeafCidBytes(await sha256(bytes)), tsize: bytes.length },
  ];
  const node = encodeDirNode(links);
  const digest = await sha256(node);
  if (!equalBytes(digest, rootCid.digest)) {
    throw new VerificationError(
      `metadata.json does not reconstruct the root: ` +
        `got ${formatCidV1(DAG_PB_CODE, digest)}, want ${rootCidText}`,
    );
  }
}

function parseMapSection(
  raw: Record<string, unknown>,
  children: ManifestChild[],
): Omit<MapManifest, 'children'> {
  const map = raw.map as Record<string, unknown> | undefined;
  const proofs = raw.proofs as Record<string, unknown> | undefined;
  const mapFile = assertName(map?.file, 'map.file');
  const mapSize = assertSize(map?.size, 'map.size');
  const proofsDir = assertName(proofs?.dir, 'proofs.dir');
  const metaDigest = proofs?.metaDigest;
  if (typeof metaDigest !== 'string' || !DIGEST_HEX_RE.test(metaDigest)) {
    throw new VerificationError('metadata.json: proofs.metaDigest is not a hex sha2-256 digest');
  }
  // proofs.shardCapBytes is publisher documentation only: the client enforces
  // the format's own 64 KiB shard cap (proof-format.ts), so it is not read.
  requireChildren(children, [mapFile, proofsDir]);
  return { mapFile, mapSize, proofsDir, proofsMetaDigest: metaDigest };
}

// Strict validation of the untrusted children list; every entry is later
// load-bearing in the reconstruction, so malformed input is a hard reject
// before any use.
function parseChildren(rawChildren: unknown): ManifestChild[] {
  if (!Array.isArray(rawChildren) || rawChildren.length === 0 || rawChildren.length > MAX_CHILDREN) {
    throw new VerificationError('metadata.json: children must be a non-empty array');
  }
  const seen = new Set<string>();
  return rawChildren.map((c: Record<string, unknown> | undefined, i) => {
    const name = assertName(c?.name, `children[${i}].name`);
    if (name === METADATA_NAME) {
      throw new VerificationError('metadata.json: children must not list metadata.json itself');
    }
    if (seen.has(name)) throw new VerificationError(`metadata.json: duplicate child ${name}`);
    seen.add(name);
    return {
      name,
      cid: parseCid(c?.cid, `metadata.json: ${name}`),
      tsize: assertSize(c?.tsize, `${name}.tsize`),
    };
  });
}

function requireChildren(children: ManifestChild[], names: string[]): void {
  for (const name of names) {
    if (!children.some((c) => c.name === name)) {
      throw new VerificationError(`metadata.json: children missing entry for ${name}`);
    }
  }
}

// Every referenced name must be a single non-empty path segment, so a
// tampered manifest can never steer a fetch outside the package base.
function assertName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value === '.' ||
    value === '..'
  ) {
    throw new VerificationError(`metadata.json: invalid name for ${label}`);
  }
  return value;
}

function assertSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new VerificationError(`metadata.json: invalid size for ${label}`);
  }
  return value as number;
}
