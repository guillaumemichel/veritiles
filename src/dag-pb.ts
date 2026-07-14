// Canonical dag-pb encoding of a UnixFS directory node — the write half of
// the IPLD dag-pb spec, just enough to rebuild a root directory block
// byte-for-byte. Wire format:
//
//   PBLink = Hash:bytes(1) Name:string(2) Tsize:uint64(3), fields ascending
//   PBNode = repeated Links(2), then Data(1) — dag-pb's historical quirk:
//            links precede data in the byte stream despite the higher tag
//
// Links must be sorted by the UTF-8 bytes of Name. The encoder sorts here,
// so any permutation of the same links yields the same canonical block; a
// duplicate name (unrepresentable in a real directory) rejects.

import { VerificationError } from './verify.ts';

export interface DirLink {
  name: string;
  cidBytes: Uint8Array;
  tsize: number;
}

// A UnixFS directory node's Data field is the constant protobuf {Type: 1}.
const DIR_NODE_DATA = Uint8Array.of(0x08, 0x01);

export function encodeDirNode(links: DirLink[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = links
    .map((link) => encodeLink(link, encoder.encode(link.name)))
    .sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  for (let i = 1; i < encoded.length; i++) {
    if (compareBytes(encoded[i - 1]!.nameBytes, encoded[i]!.nameBytes) === 0) {
      throw new VerificationError('duplicate link name in directory node');
    }
  }
  const parts: Uint8Array[] = [];
  for (const { bytes } of encoded) {
    parts.push(Uint8Array.of(0x12), varint(bytes.length), bytes);
  }
  parts.push(Uint8Array.of(0x0a), varint(DIR_NODE_DATA.length), DIR_NODE_DATA);
  return concatBytes(parts);
}

function encodeLink(
  { cidBytes, tsize }: DirLink,
  nameBytes: Uint8Array,
): { nameBytes: Uint8Array; bytes: Uint8Array } {
  if (!Number.isSafeInteger(tsize) || tsize < 0) {
    throw new VerificationError('link tsize must be a non-negative safe integer');
  }
  const bytes = concatBytes([
    Uint8Array.of(0x0a),
    varint(cidBytes.length),
    cidBytes,
    Uint8Array.of(0x12),
    varint(nameBytes.length),
    nameBytes,
    Uint8Array.of(0x18),
    varint(tsize),
  ]);
  return { nameBytes, bytes };
}

// Unsigned LEB128. Division instead of bit ops: tsize may exceed 2^31.
function varint(value: number): Uint8Array {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 0x80) + 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
  return Uint8Array.from(out);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
