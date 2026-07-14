// Digest verification primitives: sha2-256 only — the hash every CID and
// proof record in a package uses. WebCrypto requires a secure context
// (https or localhost). Digests travel as lowercase hex strings client-side.

export const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;

export class VerificationError extends Error {
  override name = 'VerificationError';
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // The cast bridges TS ≥ 5.7's Uint8Array<ArrayBufferLike> to BufferSource;
  // nothing here ever backs a view with a SharedArrayBuffer.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

// Throws unless sha256(bytes) matches the expected lowercase hex digest.
export async function verifyDigest(
  expectedHex: string,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  if (!DIGEST_HEX_RE.test(expectedHex)) {
    throw new VerificationError(`${label}: malformed expected digest`);
  }
  if (toHex(await sha256(bytes)) !== expectedHex) {
    throw new VerificationError(`${label}: digest mismatch`);
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
