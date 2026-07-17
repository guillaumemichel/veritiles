// Tiny protobuf/varint writers for crafting invalid UnixFS nodes and proof
// sections byte-by-byte. Valid-shape fixtures always come from the reference
// importer; these builders exist only to drive the reject branches.

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

const SHA2_256 = 0x12;
const RAW = 0x55;

export function uvarint(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

// A varint-wire-type field (wire type 0): tag byte, then the varint value.
export function tagV(tag: number, value: number | bigint): Uint8Array {
  return concatBytes(uvarint(tag), uvarint(value));
}

// A length-delimited field (wire type 2): tag byte, varint length, bytes.
export function tagL(tag: number, bytes: Uint8Array): Uint8Array {
  return concatBytes(uvarint(tag), uvarint(bytes.length), bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// The binary bytes of a CIDv1 over a 32-byte sha2-256 digest (default raw).
export function cidBytes(digest: Uint8Array, codec = RAW): Uint8Array {
  return CID.createV1(codec, Digest.create(SHA2_256, digest)).bytes;
}

export interface LinkParts {
  hash: Uint8Array;
  name?: string;
  nameBytes?: Uint8Array;
  tsize?: number;
}

// A canonical PBLink message body (Hash, then optional Name, then Tsize).
export function pbLink({ hash, name, nameBytes, tsize }: LinkParts): Uint8Array {
  const parts = [tagL(0x0a, hash)];
  if (nameBytes !== undefined) parts.push(tagL(0x12, nameBytes));
  else if (name !== undefined) parts.push(tagL(0x12, new TextEncoder().encode(name)));
  if (tsize !== undefined) parts.push(tagV(0x18, tsize));
  return concatBytes(...parts);
}

// A PBNode: each link wrapped as field 2 (0x12), then Data as field 1 (0x0a).
export function pbNode(links: Uint8Array[], data: Uint8Array): Uint8Array {
  return concatBytes(...links.map((l) => tagL(0x12, l)), tagL(0x0a, data));
}

export interface UnixFsFields {
  type?: number;
  inlineData?: Uint8Array;
  filesize?: number | bigint;
  blocksizes?: (number | bigint)[];
  hashType?: number;
  fanout?: number;
  mode?: number;
  mtime?: Uint8Array;
}

// A UnixFS Data message in canonical ascending field order.
export function unixfsData(f: UnixFsFields): Uint8Array {
  const parts: Uint8Array[] = [];
  if (f.type !== undefined) parts.push(tagV(0x08, f.type));
  if (f.inlineData !== undefined) parts.push(tagL(0x12, f.inlineData));
  if (f.filesize !== undefined) parts.push(tagV(0x18, f.filesize));
  for (const b of f.blocksizes ?? []) parts.push(tagV(0x20, b));
  if (f.hashType !== undefined) parts.push(tagV(0x28, f.hashType));
  if (f.fanout !== undefined) parts.push(tagV(0x30, f.fanout));
  if (f.mode !== undefined) parts.push(tagV(0x38, f.mode));
  if (f.mtime !== undefined) parts.push(tagL(0x42, f.mtime));
  return concatBytes(...parts);
}

// A directory node with the given (name, cidBytes) links, in the given order.
export function dirNode(links: { name: string; hash: Uint8Array; tsize?: number }[]): Uint8Array {
  return pbNode(
    links.map((l) => pbLink({ hash: l.hash, name: l.name, tsize: l.tsize })),
    unixfsData({ type: 1 }),
  );
}
