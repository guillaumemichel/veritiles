import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { BLOCK_CAP, parseProof } from '../src/proof.ts';
import { VerificationError } from '../src/verify.ts';
import { deterministicBytes, sha256Bytes } from './helpers/bytes.ts';
import { buildBig, buildTree } from './helpers/fixtures.ts';
import { concatBytes, uvarint } from './helpers/protobuf.ts';

const DAG_PB = 0x70;
const RAW = 0x55;
const DAG_CBOR = 0x71;
const SHA2_256 = 0x12;
const SHA2_512 = 0x13;

const HEADER_PREFIX = Uint8Array.of(
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
);
const HEADER_SUFFIX = Uint8Array.of(0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01);

const sha512 = (b: Uint8Array) => new Uint8Array(createHash('sha512').update(b).digest());
const rejects = (bytes: Uint8Array) => assert.rejects(parseProof(bytes, 'proof'), VerificationError);

function frame(cidBytes: Uint8Array, block: Uint8Array): Uint8Array {
  return concatBytes(uvarint(cidBytes.length + block.length), cidBytes, block);
}
function sectionOf(block: Uint8Array, codec = DAG_PB, hashCode = SHA2_256): Uint8Array {
  const digest = hashCode === SHA2_512 ? sha512(block) : sha256Bytes(block);
  return frame(CID.createV1(codec, Digest.create(hashCode, digest)).bytes, block);
}
function craft(rootDigest: Uint8Array, ...sections: Uint8Array[]): Uint8Array {
  return concatBytes(HEADER_PREFIX, rootDigest, HEADER_SUFFIX, ...sections);
}
async function carBlocks(proof: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = await CarReader.fromBytes(proof);
  const out = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) out.set((block.cid as unknown as CID).multihash.digest.reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''), block.bytes);
  return out;
}

// --- Header (P-H) ---

test('P-H-01 FIX-BIG proof header is the template with the root digest', async () => {
  const big = await buildBig();
  const rootDigest = CID.parse(big.rootCid).multihash.digest;
  const expected = concatBytes(HEADER_PREFIX, rootDigest, HEADER_SUFFIX);
  assert.deepEqual(big.proof!.subarray(0, 59), expected);
});

test('P-H-02 flipping any fixed header byte rejects', async () => {
  const big = await buildBig();
  for (const offset of [...range(0, 18), ...range(50, 59)]) {
    const mutated = new Uint8Array(big.proof!);
    mutated[offset]! ^= 0xff;
    await rejects(mutated);
  }
});

test('P-H-03 a valid proof exposes the dag-pb root from bytes 18..49', async () => {
  const big = await buildBig();
  const { root } = await parseProof(big.proof!, 'proof');
  assert.equal(root.codec, DAG_PB);
  assert.deepEqual(root.digest, big.proof!.subarray(18, 50));
  assert.deepEqual(root.digest, CID.parse(big.rootCid).multihash.digest);
});

test('P-H-04 a proof shorter than 59 bytes rejects', async () => {
  await rejects(new Uint8Array(58));
});

// --- Sections (P-S) ---

test('P-S-01 FIX-TREE blocks are keyed by digest hex and byte-equal', async () => {
  const tree = await buildTree();
  const { blocks } = await parseProof(tree.proof!, 'proof');
  const reference = await carBlocks(tree.proof!);
  assert.equal(blocks.size, reference.size);
  for (const [key, bytes] of reference) assert.deepEqual(blocks.get(key), bytes);
});

test('P-S-02 section CID with raw or dag-cbor codec rejects', async () => {
  const root = deterministicBytes(32, 1);
  const block = deterministicBytes(50, 2);
  await rejects(craft(root, sectionOf(block, RAW)));
  await rejects(craft(root, sectionOf(block, DAG_CBOR)));
});

test('P-S-03 a flipped block byte (stale CID) rejects', async () => {
  const root = deterministicBytes(32, 3);
  const block = deterministicBytes(50, 4);
  const cid = CID.createV1(DAG_PB, Digest.create(SHA2_256, sha256Bytes(block))).bytes;
  const tampered = new Uint8Array(block);
  tampered[0]! ^= 0xff;
  await rejects(craft(root, frame(cid, tampered)));
});

test('P-S-04 a duplicate section rejects', async () => {
  const root = deterministicBytes(32, 5);
  const section = sectionOf(deterministicBytes(50, 6));
  await rejects(craft(root, section, section));
});

test('P-S-05 out-of-range and non-minimal section lengths reject', async () => {
  const root = deterministicBytes(32, 7);
  const cid = CID.createV1(DAG_PB, Digest.create(SHA2_256, sha256Bytes(new Uint8Array(1)))).bytes;
  await rejects(concatBytes(HEADER_PREFIX, root, HEADER_SUFFIX, uvarint(36))); // < CID + 1
  await rejects(concatBytes(HEADER_PREFIX, root, HEADER_SUFFIX, uvarint(36 + BLOCK_CAP + 1))); // over cap
  await rejects(concatBytes(HEADER_PREFIX, root, HEADER_SUFFIX, Uint8Array.of(0xa8, 0x00), cid)); // non-minimal 40
  await rejects(concatBytes(HEADER_PREFIX, root, HEADER_SUFFIX, new Uint8Array(10).fill(0x80), Uint8Array.of(0x01))); // varint too long
});

test('P-S-06 truncation and short trailing bytes reject', async () => {
  const tree = await buildTree();
  await rejects(tree.proof!.subarray(0, tree.proof!.length - 5)); // truncated mid-section
  await rejects(concatBytes(tree.proof!, uvarint(37))); // a length with no section body
});

test('P-S-07 a header-only proof parses to an empty block map', async () => {
  const root = deterministicBytes(32, 8);
  const { blocks } = await parseProof(concatBytes(HEADER_PREFIX, root, HEADER_SUFFIX), 'proof');
  assert.equal(blocks.size, 0);
});

test('P-S-08 an extra unreachable dag-pb block parses and is inert', async () => {
  const tree = await buildTree();
  const extra = sectionOf(deterministicBytes(80, 9));
  const { blocks } = await parseProof(concatBytes(tree.proof!, extra), 'proof');
  const reference = await carBlocks(tree.proof!);
  assert.equal(blocks.size, reference.size + 1);
  assert.deepEqual(blocks.get(sha256Bytes(deterministicBytes(80, 9)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')), deterministicBytes(80, 9));
});

test('P-S-09 non-sha256 or wrong-length section digest rejects', async () => {
  const root = deterministicBytes(32, 10);
  const block = deterministicBytes(50, 11);
  await rejects(craft(root, sectionOf(block, DAG_PB, SHA2_512))); // sha2-512 multihash
  // dag-pb sha2-256 CID declaring a 16-byte digest.
  const shortCid = concatBytes(Uint8Array.of(0x01, 0x70, 0x12, 0x10), deterministicBytes(16, 12));
  await rejects(craft(root, frame(shortCid, block)));
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
