// The ranges trust bootstrap is a strict DRISL descriptor. Its `map` is the
// whole-file raw CID; `unixfs` is an optional, ignored IPFS publishing bridge.

import { type Cid, DAG_PB_CODE, decodeCidBytes, RAW_CODE, SHA2_256_CODE } from './cid.ts';
import { byteString, encodeBytesHead, encodeUint, uint } from './drisl.ts';
import { DESCRIPTOR_CAP } from './limits.ts';
import { decodeMeta } from './proof-format.ts';
import type { VerifiedStore } from './verified-store.ts';
import { toHex, VerificationError } from './verify.ts';

export const FORMAT_VERSION = 1;

export interface Descriptor {
  /** The raw CID of the complete map file. */
  mapCid: Cid;
  /** Optional UnixFS root for external IPFS pinning; never fetched by clients. */
  unixfsCid?: Cid;
  mapSize: number;
  topMeta: Uint8Array;
}

export async function openDescriptor(anchor: Cid, store: VerifiedStore, { signal }: { signal?: AbortSignal } = {}): Promise<Descriptor> {
  return decodeDescriptor(await store.fetchWhole('root', toHex(anchor.digest), DESCRIPTOR_CAP, { signal }));
}

export function decodeDescriptor(bytes: Uint8Array): Descriptor {
  const cursor = { pos: 0 };
  const count = bytes[cursor.pos++];
  if (count !== 0xa4 && count !== 0xa5) throw new VerificationError('descriptor: not the canonical descriptor template');
  expect(bytes, cursor, [0x61, 0x76]);
  const version = uint(bytes, cursor, 'descriptor: v');
  if (version !== FORMAT_VERSION) throw new VerificationError(`descriptor: unsupported format version ${version}`);
  expect(bytes, cursor, [0x63, 0x6d, 0x61, 0x70, 0xd8, 0x2a, 0x58, 0x25, 0x00]);
  const mapCid = decodeCidBytes(bytes, cursor, 'descriptor: map');
  gate(mapCid, RAW_CODE, 'descriptor: map CID codec must be raw');
  expect(bytes, cursor, [0x64, 0x6d, 0x65, 0x74, 0x61]);
  const topMeta = byteString(bytes, cursor, 'descriptor: meta');
  let unixfsCid: Cid | undefined;
  if (count === 0xa5) {
    expect(bytes, cursor, [0x66, 0x75, 0x6e, 0x69, 0x78, 0x66, 0x73, 0xd8, 0x2a, 0x58, 0x25, 0x00]);
    unixfsCid = decodeCidBytes(bytes, cursor, 'descriptor: unixfs');
    if (unixfsCid.hashCode !== SHA2_256_CODE || unixfsCid.digest.length !== 32 || (unixfsCid.codec !== RAW_CODE && unixfsCid.codec !== DAG_PB_CODE)) {
      throw new VerificationError('descriptor: unixfs CID must be raw or dag-pb sha2-256 with a 32-byte digest');
    }
  }
  expect(bytes, cursor, [0x67, 0x6d, 0x61, 0x70, 0x53, 0x69, 0x7a, 0x65]);
  const mapSize = uint(bytes, cursor, 'descriptor: mapSize');
  if (cursor.pos !== bytes.length) throw new VerificationError('descriptor: trailing bytes');
  const { covered } = decodeMeta(topMeta, 0);
  if (covered !== mapSize) throw new VerificationError(`descriptor: meta covers ${covered} bytes, expected mapSize ${mapSize}`);
  return { mapCid, ...(unixfsCid === undefined ? {} : { unixfsCid }), mapSize, topMeta };
}

export function encodeDescriptor({ mapCidBytes, unixfsCidBytes, topMeta, mapSize }: {
  mapCidBytes: Uint8Array;
  unixfsCidBytes?: Uint8Array;
  topMeta: Uint8Array;
  mapSize: number;
}): Uint8Array {
  if (mapCidBytes.length !== 36) throw new Error('map CID must be 36 binary bytes');
  if (unixfsCidBytes !== undefined && unixfsCidBytes.length !== 36) throw new Error('unixfs CID must be 36 binary bytes');
  const parts = [
    Uint8Array.of(unixfsCidBytes === undefined ? 0xa4 : 0xa5, 0x61, 0x76, ...encodeUint(FORMAT_VERSION), 0x63, 0x6d, 0x61, 0x70, 0xd8, 0x2a, 0x58, 0x25, 0x00),
    mapCidBytes,
    Uint8Array.of(0x64, 0x6d, 0x65, 0x74, 0x61), encodeBytesHead(topMeta.length), topMeta,
  ];
  if (unixfsCidBytes !== undefined) parts.push(Uint8Array.of(0x66, 0x75, 0x6e, 0x69, 0x78, 0x66, 0x73, 0xd8, 0x2a, 0x58, 0x25, 0x00), unixfsCidBytes);
  parts.push(Uint8Array.of(0x67, 0x6d, 0x61, 0x70, 0x53, 0x69, 0x7a, 0x65), encodeUint(mapSize));
  return concat(parts);
}

function expect(bytes: Uint8Array, cursor: { pos: number }, want: number[]): void {
  for (const byte of want) if (bytes[cursor.pos++] !== byte) throw new VerificationError('descriptor: not the canonical descriptor template');
}

function gate(cid: Cid, codec: number, error: string): void {
  if (cid.codec !== codec) throw new VerificationError(error);
  if (cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) throw new VerificationError('descriptor: map CID must be sha2-256 with a 32-byte digest');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
