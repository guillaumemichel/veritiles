// CAR helpers for the test suites. Read a CAR's sections; craft a bag from an
// arbitrary root digest + section list (v3: claimed CIDs are untrusted index
// keys, so a section may lie about its own bytes to drive a reject); and wrap
// a CARv1 in a CARv2 envelope, with a padded variant whose payload is NOT at
// byte 51 (the measured invariant the parser must honor via dataOffset).

import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { sha256Bytes } from './bytes.ts';
import { concatBytes, uvarint } from './protobuf.ts';

const SHA2_256 = 0x12;
const DAG_PB = 0x70;

// The fixed 11-byte CARv2 pragma (measured against @ipld/car).
export const CARV2_PRAGMA = Uint8Array.of(
  0x0a, 0xa1, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x02,
);

// Wrap a CARv1 payload in a CARv2 envelope. `padding` zero bytes sit between
// the 40-byte header and the payload, so dataOffset ≠ 51 exercises the seek.
export function wrapCarV2(carv1: Uint8Array, { padding = 0 }: { padding?: number } = {}): Uint8Array {
  const header = new Uint8Array(40); // characteristics u128 = 0
  const dv = new DataView(header.buffer);
  const dataOffset = CARV2_PRAGMA.length + 40 + padding;
  dv.setBigUint64(16, BigInt(dataOffset), true);
  dv.setBigUint64(24, BigInt(carv1.length), true); // dataSize
  dv.setBigUint64(32, 0n, true); // indexOffset: none
  return concatBytes(CARV2_PRAGMA, header, new Uint8Array(padding), carv1);
}

// A raw section wrapped with its correct CID — the honest content-adopting case.
export function rawSection(block: Uint8Array): Section {
  return { cidBytes: CID.createV1(0x55, Digest.create(SHA2_256, sha256Bytes(block))).bytes, block };
}

// A section whose claimed CID lies about its bytes: parses (claims are index
// keys), caught only when the block is used and hashed (SPEC §3.3).
export function lyingSection(claimedDigest: Uint8Array, block: Uint8Array, codec = DAG_PB): Section {
  return { cidBytes: CID.createV1(codec, Digest.create(SHA2_256, claimedDigest)).bytes, block };
}

// A bare CARv1 from a root + section list, no header-template constraint (the
// header is skipped, not parsed, in v3). Uses a minimal single-root header.
export function craftCar(root: CID, sections: Section[]): Uint8Array {
  return concatBytes(carHeader(root), ...sections.map(frameSection));
}

function carHeader(root: CID): Uint8Array {
  // dag-cbor { roots: [root], version: 1 }, length-prefixed. Bytes cribbed
  // from the canonical writer; only the root CID bytes vary.
  const body = concatBytes(
    Uint8Array.of(0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x25, 0x00),
    root.bytes,
    Uint8Array.of(0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01),
  );
  return concatBytes(uvarint(body.length), body);
}

export interface Section {
  cidBytes: Uint8Array;
  block: Uint8Array;
}

export async function carSections(proof: Uint8Array): Promise<{ cid: CID; bytes: Uint8Array }[]> {
  const reader = await CarReader.fromBytes(proof);
  const out: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const block of reader.blocks()) out.push({ cid: block.cid as unknown as CID, bytes: block.bytes });
  return out;
}

// A dag-pb block wrapped as a section — its CID is dag-pb sha2-256 over the
// block, so the section is well-formed and only the rule under test fires.
export function dagPbSection(block: Uint8Array): Section {
  return { cidBytes: CID.createV1(0x70, Digest.create(SHA2_256, sha256Bytes(block))).bytes, block };
}

export function frameSection({ cidBytes, block }: Section): Uint8Array {
  return concatBytes(uvarint(cidBytes.length + block.length), cidBytes, block);
}

export function dagPbCid(block: Uint8Array): CID {
  return CID.createV1(0x70, Digest.create(SHA2_256, sha256Bytes(block)));
}

export function rawCid(content: Uint8Array): CID {
  return CID.createV1(0x55, Digest.create(SHA2_256, sha256Bytes(content)));
}
