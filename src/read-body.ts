// Read a response body into a single Uint8Array, aborting the moment it
// exceeds `limit` bytes — an untrusted host must never stream unbounded
// data. Shared by every transport; verification happens above.

import { VerificationError } from './verify.ts';

export async function readBody(res: Response, limit: number): Promise<Uint8Array> {
  // A body-less response (e.g. 204) has no bytes to verify — treat it as a
  // failed fetch, not an unguarded TypeError.
  if (!res.body) throw new VerificationError('response has no body');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new VerificationError(`response exceeds expected length ${limit}`);
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
