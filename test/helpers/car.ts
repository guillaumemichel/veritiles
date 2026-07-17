// CARv1 proof helpers for the asset suite: read a proof's sections, and craft
// a proof from a chosen root digest + section list, recomputing the anchor
// over the mutated bytes so the whole-body hash passes and the rule under test
// is what fires.

import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { sha256Bytes } from './bytes.ts';
import { concatBytes, uvarint } from './protobuf.ts';

const CAR_CODE = 0x0202;
const SHA2_256 = 0x12;

const HEADER_PREFIX = Uint8Array.of(
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
);
const HEADER_SUFFIX = Uint8Array.of(0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01);

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

// Build a proof CAR from a root digest and section list, in the given order.
export function craftProof(rootDigest: Uint8Array, sections: Section[]): Uint8Array {
  return concatBytes(HEADER_PREFIX, rootDigest, HEADER_SUFFIX, ...sections.map(frameSection));
}

export function anchorText(proof: Uint8Array): string {
  return CID.createV1(CAR_CODE, Digest.create(SHA2_256, sha256Bytes(proof))).toString();
}

export function dagPbCid(block: Uint8Array): CID {
  return CID.createV1(0x70, Digest.create(SHA2_256, sha256Bytes(block)));
}

export function rawCid(content: Uint8Array): CID {
  return CID.createV1(0x55, Digest.create(SHA2_256, sha256Bytes(content)));
}
