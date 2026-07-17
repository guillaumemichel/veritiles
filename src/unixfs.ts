// Strict UnixFS node decoder (A6): a minimal protobuf reader that accepts only
// the two node shapes a verified artifact walk needs — a plain directory and a
// multi-chunk file — in canonical dag-pb form. Everything else (Raw, Symlink,
// Metadata, HAMTShard, inline data, unknown fields, non-canonical order, CIDv0,
// non-sha2-256) rejects. Accepting fewer shapes can only reject an artifact,
// never mis-verify one. The wire reference is at the end of spec A6.
//
//   PBNode  = Links(2, 0x12)* then Data(1, 0x0a) once
//   PBLink  = Hash(1, 0x0a) once, then Name(2, 0x12)?, then Tsize(3, 0x18)?
//   UnixFS  = Type(0x08) filesize(0x18) blocksizes(0x20)* hashType(0x28)
//             fanout(0x30) mode(0x38) mtime(0x42) — ascending tag order

import { assertNodeLinkCid, type Cid, decodeCidBytes } from './cid.ts';
import { VerificationError } from './verify.ts';

export type UnixFsNode =
  | { kind: 'dir'; links: { name: string; cid: Cid }[] }
  | { kind: 'file'; filesize: number; parts: { cid: Cid; blocksize: number }[] };

const TYPE_DIRECTORY = 1;
const TYPE_FILE = 2;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function decodeNode(bytes: Uint8Array, label: string): UnixFsNode {
  const { links, data } = parsePbNode(bytes, label);
  const unix = parseUnixFsData(data, label);
  if (unix.type === TYPE_DIRECTORY) return decodeDirectory(links, unix, label);
  if (unix.type === TYPE_FILE) return decodeFile(links, unix, label);
  throw new VerificationError(`${label}: unsupported UnixFS node type ${unix.type}`);
}

// Index of `name` in sorted directory links, or -1. Names sort by UTF-8 bytes
// (A6), so the search compares encoded bytes rather than JS code units.
export function findLink(links: { name: string }[], name: string): number {
  const target = new TextEncoder().encode(name);
  let lo = 0;
  let hi = links.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareBytes(new TextEncoder().encode(links[mid]!.name), target);
    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface RawLink {
  cid: Cid;
  nameBytes: Uint8Array | undefined;
  name: string | undefined;
}

function parsePbNode(bytes: Uint8Array, label: string): { links: RawLink[]; data: Uint8Array } {
  const cursor = { pos: 0 };
  const links: RawLink[] = [];
  let data: Uint8Array | undefined;
  while (cursor.pos < bytes.length) {
    const tag = readVarint(bytes, cursor, label);
    if (tag === 0x12) {
      if (data !== undefined) throw new VerificationError(`${label}: Data precedes a Link (non-canonical order)`);
      links.push(parsePbLink(readLengthDelimited(bytes, cursor, label), label));
    } else if (tag === 0x0a) {
      if (data !== undefined) throw new VerificationError(`${label}: duplicate Data field`);
      data = readLengthDelimited(bytes, cursor, label);
    } else {
      throw new VerificationError(`${label}: unexpected PBNode field tag ${tag}`);
    }
  }
  if (data === undefined) throw new VerificationError(`${label}: node has no Data field`);
  return { links, data };
}

function parsePbLink(field: Uint8Array, label: string): RawLink {
  const cursor = { pos: 0 };
  let cid: Cid | undefined;
  let nameBytes: Uint8Array | undefined;
  let name: string | undefined;
  let lastTag = 0;
  while (cursor.pos < field.length) {
    const tag = readVarint(field, cursor, label);
    if (tag <= lastTag) throw new VerificationError(`${label}: PBLink fields out of order or duplicated`);
    lastTag = tag;
    if (tag === 0x0a) {
      const hash = readLengthDelimited(field, cursor, label);
      const inner = { pos: 0 };
      cid = decodeCidBytes(hash, inner, `${label}: link Hash`);
      if (inner.pos !== hash.length) throw new VerificationError(`${label}: link Hash has trailing bytes`);
      assertNodeLinkCid(cid, `${label}: link`);
    } else if (tag === 0x12) {
      nameBytes = readLengthDelimited(field, cursor, label);
      name = decodeUtf8(nameBytes, `${label}: link Name`);
    } else if (tag === 0x18) {
      readVarint(field, cursor, label); // Tsize: parsed and discarded (A6)
    } else {
      throw new VerificationError(`${label}: unknown PBLink field tag ${tag}`);
    }
  }
  if (cid === undefined) throw new VerificationError(`${label}: link has no Hash`);
  return { cid, nameBytes, name };
}

interface UnixFsData {
  type: number;
  filesize: number | undefined;
  blocksizes: number[];
  hasInlineData: boolean;
  hasHashType: boolean;
  hasFanout: boolean;
}

function parseUnixFsData(bytes: Uint8Array, label: string): UnixFsData {
  const cursor = { pos: 0 };
  let type: number | undefined;
  let filesize: number | undefined;
  const blocksizes: number[] = [];
  let hasInlineData = false;
  let hasHashType = false;
  let hasFanout = false;
  let lastTag = 0;
  while (cursor.pos < bytes.length) {
    const tag = readVarint(bytes, cursor, label);
    if (tag < lastTag) throw new VerificationError(`${label}: UnixFS fields out of ascending order`);
    if (tag === lastTag && tag !== 0x20) throw new VerificationError(`${label}: duplicate UnixFS field ${tag}`);
    lastTag = tag;
    switch (tag) {
      case 0x08:
        type = readVarint(bytes, cursor, label);
        break;
      case 0x12:
        readLengthDelimited(bytes, cursor, label);
        hasInlineData = true;
        break;
      case 0x18:
        filesize = readVarint(bytes, cursor, label);
        break;
      case 0x20:
        blocksizes.push(readVarint(bytes, cursor, label));
        break;
      case 0x28:
        readVarint(bytes, cursor, label);
        hasHashType = true;
        break;
      case 0x30:
        readVarint(bytes, cursor, label);
        hasFanout = true;
        break;
      case 0x38:
        readVarint(bytes, cursor, label); // mode: ignored (A6)
        break;
      case 0x42:
        readLengthDelimited(bytes, cursor, label); // mtime: ignored (A6)
        break;
      default:
        throw new VerificationError(`${label}: unknown UnixFS field tag ${tag}`);
    }
  }
  if (type === undefined) throw new VerificationError(`${label}: UnixFS Data has no Type`);
  return { type, filesize, blocksizes, hasInlineData, hasHashType, hasFanout };
}

function decodeDirectory(links: RawLink[], unix: UnixFsData, label: string): UnixFsNode {
  if (unix.hasInlineData) throw new VerificationError(`${label}: directory has inline Data`);
  if (unix.filesize !== undefined) throw new VerificationError(`${label}: directory has filesize`);
  if (unix.blocksizes.length > 0) throw new VerificationError(`${label}: directory has blocksizes`);
  if (unix.hasHashType) throw new VerificationError(`${label}: directory has hashType`);
  if (unix.hasFanout) throw new VerificationError(`${label}: directory has fanout`);

  const out: { name: string; cid: Cid }[] = [];
  let previous: Uint8Array | undefined;
  for (const link of links) {
    if (link.nameBytes === undefined || link.nameBytes.length === 0) {
      throw new VerificationError(`${label}: directory link has no Name`);
    }
    if (link.nameBytes.length > 255) throw new VerificationError(`${label}: directory link Name over 255 bytes`);
    const name = link.name!;
    if (link.nameBytes.includes(0)) throw new VerificationError(`${label}: directory link Name contains NUL`);
    if (name.includes('/')) throw new VerificationError(`${label}: directory link Name contains '/'`);
    if (name === '.' || name === '..') throw new VerificationError(`${label}: directory link Name is '${name}'`);
    if (previous !== undefined && compareBytes(previous, link.nameBytes) >= 0) {
      throw new VerificationError(`${label}: directory links not strictly sorted by Name`);
    }
    previous = link.nameBytes;
    out.push({ name, cid: link.cid });
  }
  return { kind: 'dir', links: out };
}

function decodeFile(links: RawLink[], unix: UnixFsData, label: string): UnixFsNode {
  if (unix.hasInlineData) throw new VerificationError(`${label}: file node has inline Data`);
  if (unix.hasHashType) throw new VerificationError(`${label}: file node has hashType`);
  if (unix.hasFanout) throw new VerificationError(`${label}: file node has fanout`);
  if (unix.filesize === undefined) throw new VerificationError(`${label}: file node has no filesize`);
  if (links.length === 0) throw new VerificationError(`${label}: file node has no links`);
  if (unix.blocksizes.length !== links.length) {
    throw new VerificationError(`${label}: file node blocksizes count ≠ link count`);
  }

  const parts: { cid: Cid; blocksize: number }[] = [];
  let total = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    if (link.nameBytes !== undefined && link.nameBytes.length > 0) {
      throw new VerificationError(`${label}: file node link has a Name`);
    }
    const blocksize = unix.blocksizes[i]!;
    if (blocksize < 1) throw new VerificationError(`${label}: file node blocksize is zero`);
    total += blocksize;
    parts.push({ cid: link.cid, blocksize });
  }
  if (total !== unix.filesize) {
    throw new VerificationError(`${label}: file node filesize ≠ sum of blocksizes`);
  }
  return { kind: 'file', filesize: unix.filesize, parts };
}

// A length-delimited protobuf field: varint length, then that many bytes.
function readLengthDelimited(bytes: Uint8Array, cursor: { pos: number }, label: string): Uint8Array {
  const length = readVarint(bytes, cursor, label);
  const end = cursor.pos + length;
  if (end > bytes.length) throw new VerificationError(`${label}: field runs past end of block`);
  const out = bytes.subarray(cursor.pos, end);
  cursor.pos = end;
  return out;
}

// Unsigned LEB128 up to 2⁵³ — sizes must be safe integers (A6, `< 2⁵³`).
function readVarint(bytes: Uint8Array, cursor: { pos: number }, label: string): number {
  let value = 0;
  for (let shift = 0; shift < 64; shift += 7) {
    if (cursor.pos >= bytes.length) throw new VerificationError(`${label}: truncated varint`);
    const byte = bytes[cursor.pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new VerificationError(`${label}: integer is not below 2^53`);
      return value;
    }
  }
  throw new VerificationError(`${label}: varint too long`);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new VerificationError(`${label}: invalid UTF-8`);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
