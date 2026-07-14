import assert from 'node:assert/strict';
import { test } from 'node:test';

import { equalBytes, sha256, toHex, VerificationError, verifyDigest } from '../src/verify.ts';
import { deterministicBytes, sha256Hex } from './helpers/bytes.ts';

test('sha256 and toHex agree with node:crypto', async () => {
  const bytes = deterministicBytes(1000, 5);
  assert.equal(toHex(await sha256(bytes)), sha256Hex(bytes));
  assert.equal(toHex(Uint8Array.of(0, 1, 0xff)), '0001ff');
});

test('verifyDigest passes on a match and rejects a mismatch', async () => {
  const bytes = deterministicBytes(64, 6);
  await verifyDigest(sha256Hex(bytes), bytes, 'x');
  await assert.rejects(
    verifyDigest(sha256Hex(bytes), deterministicBytes(64, 7), 'x'),
    /x: digest mismatch/,
  );
});

test('verifyDigest rejects malformed expected digests before hashing', async () => {
  for (const bad of ['zz', '', sha256Hex(new Uint8Array(1)).toUpperCase(), 'abc']) {
    await assert.rejects(verifyDigest(bad, new Uint8Array(1), 'x'), VerificationError);
  }
});

test('equalBytes compares content, not identity', () => {
  assert.ok(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)));
  assert.ok(!equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)));
  assert.ok(!equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)));
});
