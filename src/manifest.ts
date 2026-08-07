// Strict veritiles MASL bundle profile: raw content CIDs and authenticated paths.

import { type Cid, RAW_CODE, SHA2_256_CODE } from './cid.ts';
import { encodeMapHead, encodeTag42, encodeTextHead, encodeUint, mapHead, tag42Cid, textString, uint } from './drisl.ts';
import { MANIFEST_CAP, MAX_NAME, MAX_PATH_BYTES, MAX_SEGMENTS } from './limits.ts';
import { VerificationError } from './verify.ts';

export interface ManifestEntry { src: Cid; size: number; contentType?: string; }
export interface Manifest { entries: Map<string, ManifestEntry>; }

const encoder = new TextEncoder();

export function splitPath(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS) throw new VerificationError('path: too many segments');
  for (const segment of segments) {
    if (!segment) throw new VerificationError('path: empty segment');
    if (segment === '.' || segment === '..') throw new VerificationError(`path: '${segment}' segment`);
    if (segment.includes('\0')) throw new VerificationError('path: NUL segment');
    if (encoder.encode(segment).length > MAX_NAME) throw new VerificationError('path: segment over 255 bytes');
  }
  return segments;
}

export function pathKey(segments: string[]): string { return `/${segments.join('/')}`; }

export function decodeManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MANIFEST_CAP) throw new VerificationError('manifest: body over cap');
  const cursor = { pos: 0 };
  const top = mapHead(bytes, cursor, 'manifest');
  if (top !== 1 && top !== 2) throw new VerificationError('manifest: top level must have one or two keys');
  if (top === 2) {
    const type = textString(bytes, cursor, 'manifest: key');
    if (type.text !== '$type') throw new VerificationError('manifest: $type must be first');
    const value = textString(bytes, cursor, 'manifest: $type');
    if (value.text !== 'ing.dasl.masl') throw new VerificationError('manifest: unsupported $type');
  }
  const resources = textString(bytes, cursor, 'manifest: key');
  if (resources.text !== 'resources') throw new VerificationError('manifest: missing resources');
  const count = mapHead(bytes, cursor, 'manifest: resources');
  if (count < 1) throw new VerificationError('manifest: resources is empty');
  const entries = new Map<string, ManifestEntry>();
  let previous: Uint8Array | undefined;
  for (let i = 0; i < count; i++) {
    const path = textString(bytes, cursor, 'manifest: path');
    if (previous !== undefined && compare(previous, path.encoded) >= 0) throw new VerificationError('manifest: resource keys are not strictly ordered');
    previous = path.encoded;
    validatePathKey(path.text);
    if (entries.has(path.text)) throw new VerificationError('manifest: duplicate path');
    entries.set(path.text, decodeEntry(bytes, cursor));
  }
  if (cursor.pos !== bytes.length) throw new VerificationError('manifest: trailing bytes');
  return { entries };
}

export function encodeManifest(entries: Iterable<[string, ManifestEntry]>, opts: { withType?: boolean } = {}): Uint8Array {
  const list = [...entries];
  if (list.length === 0) throw new Error('manifest must contain at least one resource');
  list.sort(([a], [b]) => compare(encodeText(a), encodeText(b)));
  const parts: Uint8Array[] = [encodeMapHead(opts.withType ? 2 : 1)];
  if (opts.withType) parts.push(encodeText('$type'), encodeText('ing.dasl.masl'));
  parts.push(encodeText('resources'), encodeMapHead(list.length));
  let previous: string | undefined;
  for (const [path, entry] of list) {
    validatePathKey(path);
    if (path === previous) throw new Error(`duplicate manifest path ${path}`);
    previous = path;
    gateSrc(entry.src, 'manifest entry');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('manifest entry size must be a uint < 2^53');
    if (entry.contentType !== undefined && (encoder.encode(entry.contentType).length < 1 || encoder.encode(entry.contentType).length > 255)) throw new Error('manifest content-type must be 1..255 bytes');
    parts.push(encodeText(path), encodeMapHead(entry.contentType === undefined ? 2 : 3));
    parts.push(encodeText('src'), encodeTag42(entry.src), encodeText('size'), encodeUint(entry.size));
    if (entry.contentType !== undefined) parts.push(encodeText('content-type'), encodeText(entry.contentType));
  }
  const out = concat(parts);
  if (out.length > MANIFEST_CAP) throw new Error('manifest body over cap');
  return out;
}

function decodeEntry(bytes: Uint8Array, cursor: { pos: number }): ManifestEntry {
  const count = mapHead(bytes, cursor, 'manifest: entry');
  if (count !== 2 && count !== 3) throw new VerificationError('manifest: entry must have two or three keys');
  expectKey(bytes, cursor, 'src', 'manifest: entry');
  const src = tag42Cid(bytes, cursor, 'manifest: src');
  gateSrc(src, 'manifest: src');
  expectKey(bytes, cursor, 'size', 'manifest: entry');
  const size = uint(bytes, cursor, 'manifest: size');
  let contentType: string | undefined;
  if (count === 3) {
    expectKey(bytes, cursor, 'content-type', 'manifest: entry');
    contentType = textString(bytes, cursor, 'manifest: content-type').text;
    const length = encoder.encode(contentType).length;
    if (length < 1 || length > 255) throw new VerificationError('manifest: content-type must be 1..255 bytes');
  }
  return { src, size, ...(contentType === undefined ? {} : { contentType }) };
}

function validatePathKey(path: string): void {
  const encoded = encoder.encode(path);
  if ((encoded.length < 2 && path !== '/') || encoded.length > MAX_PATH_BYTES || !path.startsWith('/')) throw new VerificationError('manifest: invalid resource path');
  splitPath(path.slice(1));
}

function gateSrc(cid: Cid, label: string): void {
  if (cid.codec !== RAW_CODE) throw new VerificationError(`${label}: src CID codec must be raw`);
  if (cid.hashCode !== SHA2_256_CODE || cid.digest.length !== 32) throw new VerificationError(`${label}: src CID must be sha2-256 with a 32-byte digest`);
}

function expectKey(bytes: Uint8Array, cursor: { pos: number }, value: string, label: string): void {
  if (textString(bytes, cursor, label).text !== value) throw new VerificationError(`${label}: unexpected key`);
}

function encodeText(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([encodeTextHead(bytes.length), bytes]);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
