// EarlySource: a byte source that sends a request before anything asks for
// it and hands the response to the first identical fetch — once. Every other
// fetch passes straight through.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EarlySource } from '../src/early-source.ts';
import type { Verdict } from '../src/router.ts';
import type { Body } from '../src/verdict.ts';
import type { ByteSource } from '../src/verified-store.ts';

interface Call {
  what: string;
  signal?: AbortSignal;
  verdicts: Verdict[];
  resolve: (bytes: Uint8Array) => void;
  reject: (err: unknown) => void;
}

// A source that logs every request and lets the test answer it; each body
// records the verdicts reported on it.
function manual(): { source: ByteSource; calls: Call[] } {
  const calls: Call[] = [];
  const call = (what: string, signal?: AbortSignal) =>
    new Promise<Body>((resolve, reject) => {
      const verdicts: Verdict[] = [];
      calls.push({ what, signal, verdicts, resolve: (bytes) => resolve({ bytes, settle: (v) => verdicts.push(v) }), reject });
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  return {
    calls,
    source: {
      fetchWhole: (path, _cap, { signal } = {}) => call(`whole:${path}`, signal),
      fetchRange: (path, start, length, { signal } = {}) => call(`range:${path}:${start}+${length}`, signal),
    },
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('ES-01: with nothing sent early, fetches pass straight through, sent synchronously', () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  void early.fetchWhole('0', 10);
  void early.fetchRange('', 5, 10);
  assert.deepEqual(calls.map((c) => c.what), ['whole:0', 'range::5+10']);
});

test('ES-02: the first identical fetch claims the early response, once', async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  early.sendWhole('0', 10);
  const claimed = early.fetchWhole('0', 10);
  const fresh = early.fetchWhole('0', 10);
  assert.deepEqual(calls.map((c) => c.what), ['whole:0', 'whole:0'], 'one early request, one fresh one');
  calls[0]!.resolve(Uint8Array.of(1));
  calls[1]!.resolve(Uint8Array.of(2));
  assert.deepEqual((await claimed).bytes, Uint8Array.of(1));
  assert.deepEqual((await fresh).bytes, Uint8Array.of(2));
});

test('ES-03: a failed early response is dropped and the fetch goes out fresh', async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  early.sendWhole('0', 10);
  early.sendWhole('1', 10);
  calls[1]!.reject(new Error('HTTP 503')); // never claimed: no unhandled rejection
  const claimed = early.fetchWhole('0', 10);
  calls[0]!.reject(new Error('HTTP 404'));
  await turn();
  assert.deepEqual(calls.map((c) => c.what), ['whole:0', 'whole:1', 'whole:0']);
  calls[2]!.resolve(Uint8Array.of(3));
  assert.deepEqual((await claimed).bytes, Uint8Array.of(3));
});

test('ES-04: the claimant owns the request: its abort cancels it, and nothing is re-sent', async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  early.sendWhole('0', 10);
  const controller = new AbortController();
  const claimed = early.fetchWhole('0', 10, { signal: controller.signal });
  controller.abort();
  await assert.rejects(claimed, { name: 'AbortError' });
  assert.equal(calls[0]!.signal!.aborted, true);
  assert.equal(calls.length, 1);
});

test("ES-05: an early range follows its sender's signal; release cancels and drops it unclaimed", () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  const controller = new AbortController();
  early.sendRange('', 0, 10, controller.signal);
  controller.abort();
  assert.equal(calls[0]!.signal!.aborted, true, "the sender's abort cancels it");

  const release = early.sendRange('', 20, 10);
  release();
  assert.equal(calls[1]!.signal!.aborted, true, 'release cancels it');
  void early.fetchRange('', 20, 10);
  assert.equal(calls.length, 3, 'and drops it: the next fetch goes out fresh');
});

test("ES-06: release after a claim leaves the claimant's request alone; a duplicate send is a no-op", async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  const release = early.sendRange('', 0, 10);
  const duplicate = early.sendRange('', 0, 10);
  assert.equal(calls.length, 1, 'one request for two identical sends');
  duplicate();
  const claimed = early.fetchRange('', 0, 10);
  release();
  assert.equal(calls[0]!.signal!.aborted, false);
  calls[0]!.resolve(Uint8Array.of(4));
  assert.deepEqual((await claimed).bytes, Uint8Array.of(4));
});

test('ES-07: a released or dropped response that arrived is reported unused; one in flight is cancelled', async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  const release = early.sendRange('', 0, 10);
  calls[0]!.resolve(Uint8Array.of(5));
  await turn();
  release();
  await turn();
  assert.deepEqual(calls[0]!.verdicts, ['unused']);

  early.sendWhole('0', 10);
  early.sendWhole('1', 10);
  calls[1]!.resolve(Uint8Array.of(6));
  await turn();
  early.dropUnclaimed();
  await turn();
  assert.deepEqual(calls[1]!.verdicts, ['unused'], 'arrived, then dropped');
  assert.equal(calls[2]!.signal!.aborted, true, 'still in flight: cancelled');
  void early.fetchWhole('0', 10);
  assert.equal(calls.length, 4, 'dropped: the next fetch goes out fresh');
});

test("ES-08: a claimed body is the claimant's to judge; dropping the rest leaves it alone", async () => {
  const { source, calls } = manual();
  const early = new EarlySource(source);
  early.sendWhole('0', 10);
  const claimed = early.fetchWhole('0', 10);
  early.dropUnclaimed();
  calls[0]!.resolve(Uint8Array.of(7));
  const body = await claimed;
  await turn();
  assert.deepEqual(calls[0]!.verdicts, [], 'not reported by the early source');
  body.settle('verified');
  assert.deepEqual(calls[0]!.verdicts, ['verified']);
  assert.equal(calls[0]!.signal!.aborted, false);
});
