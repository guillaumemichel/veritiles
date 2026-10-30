// Strict CARv1 proof bags. Section CIDs are untrusted lookup keys; clients hash
// a selected section before using it.

import { type Cid, DAG_CBOR_CODE, decodeCidBytes, RAW_CODE, SHA2_256_CODE } from './cid.ts';
import { DAG_CBOR_SECTION_CAP, RAW_SECTION_CAP } from './limits.ts';
import { toHex, VerificationError } from './verify.ts';

export interface BagSection { codec: number; bytes: Uint8Array; }
export type CarBag = Map<string, BagSection>;

const MIN_SECTION = 36;
const MAX_SECTION = 36 + RAW_SECTION_CAP;

export function parseCarBag(body: Uint8Array, label: string): CarBag {
  const bag: CarBag = new Map();
  const cursor = { pos: skipHeader(body, label) };
  while (cursor.pos < body.length) {
    const length = readVarintMinimal(body, cursor, `${label}: section length`);
    if (length < MIN_SECTION || length > MAX_SECTION) throw new VerificationError(`${label}: section length ${length} out of range`);
    const end = cursor.pos + length;
    if (end > body.length) throw new VerificationError(`${label}: section runs past end`);
    const cidCursor = { pos: cursor.pos };
    const cid = decodeCidBytes(body, cidCursor, `${label}: section CID`);
    gateSectionCid(cid, label);
    const block = body.subarray(cidCursor.pos, end);
    if (cid.codec === DAG_CBOR_CODE && (block.length < 1 || block.length > DAG_CBOR_SECTION_CAP)) throw new VerificationError(`${label}: dag-cbor block length ${block.length} out of range`);
    if (cid.codec === RAW_CODE && block.length > RAW_SECTION_CAP) throw new VerificationError(`${label}: raw block length ${block.length} over cap`);
    const key = toHex(cid.digest);
    if (bag.has(key)) throw new VerificationError(`${label}: duplicate section`);
    bag.set(key, { codec: cid.codec, bytes: block });
    cursor.pos = end;
  }
  return bag;
}

function skipHeader(body: Uint8Array, label: string): number {
  const cursor = { pos: 0 };
  const length = readVarintMinimal(body, cursor, `${label}: header length`);
  const end = cursor.pos + length;
  if (end > body.length) throw new VerificationError(`${label}: header runs past end`);
  return end;
}

function gateSectionCid(cid: Cid, label: string): void {
  if (cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) throw new VerificationError(`${label}: section CID must be sha2-256 with a 32-byte digest`);
  if (cid.codec !== RAW_CODE && cid.codec !== DAG_CBOR_CODE) throw new VerificationError(`${label}: section CID codec must be raw or dag-cbor`);
}

function readVarintMinimal(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  let value = 0;
  let count = 0;
  for (let shift = 0; shift < 64; shift += 7) {
    if (cursor.pos >= bytes.length) throw new VerificationError(`${label}: truncated varint`);
    const byte = bytes[cursor.pos++]!;
    count++;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (count > 1 && byte === 0) throw new VerificationError(`${label}: non-minimal varint`);
      if (!Number.isSafeInteger(value)) throw new VerificationError(`${label}: varint too large`);
      return value;
    }
  }
  throw new VerificationError(`${label}: varint too long`);
}
