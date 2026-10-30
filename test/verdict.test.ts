// Verdicts (SPEC §6): a router that carries the requests hears what veritiles
// made of each response. One response shared by several speculative readers
// settles once, after the last of them has reported.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Verdict } from '../packages/router/src/index.ts';
import { Tally, verdictOf } from '../packages/anymirror/src/verdict.ts';
import { VerificationError } from '../packages/anymirror/src/verify.ts';

function tallied() {
  const settled: Verdict[] = [];
  const tally = new Tally();
  return { tally, settled, bind: () => tally.bind((verdict) => settled.push(verdict)) };
}

test('VD-01: a shared body settles once its last reader reports', () => {
  const { tally, settled, bind } = tallied();
  const first = tally.join();
  const second = tally.join();
  bind();
  first('unused');
  assert.deepEqual(settled, [], 'a reader is still out');
  second('verified');
  assert.deepEqual(settled, ['verified']);
});

test('VD-02: rejected beats verified beats unused; a reader counts once', () => {
  const { tally, settled, bind } = tallied();
  const [a, b, c] = [tally.join(), tally.join(), tally.join()];
  a('verified');
  a('unused');
  b('rejected');
  bind();
  assert.deepEqual(settled, [], 'the second report of a reader does not stand in for another');
  c('unused');
  assert.deepEqual(settled, ['rejected']);
});

test('VD-03: readers that all left before the body arrived settle it unused, once', () => {
  const { tally, settled, bind } = tallied();
  tally.join()('unused');
  assert.deepEqual(settled, [], 'no body yet');
  bind();
  bind();
  tally.join()('verified');
  assert.deepEqual(settled, ['unused']);
});

test('VD-04: bytes that failed a check are rejected, even as the caller aborts', () => {
  const aborted = AbortSignal.abort();
  assert.equal(verdictOf(new VerificationError('digest mismatch'), aborted), 'rejected');
  assert.equal(verdictOf(new Error('network'), aborted), 'unused');
  assert.equal(verdictOf(new Error('network'), undefined), 'failed');
});
