// A byte source that can send a request before anything asks for it — the
// open overlaps `{proof}/0` and the first read's exact range with the `root`
// round trip. The first identical fetch claims the pending response, once,
// and the store above verifies it like any fresh one: same stats, bans, and
// failover. A failed early response is dropped and the fetch goes out fresh,
// so an early request can save a round trip but never change an outcome. A
// response nothing claims is dropped unused. Every other fetch passes
// straight through, sent synchronously.

import type { RangedByteSource } from './ranged-store.ts';
import type { Body } from './verdict.ts';

interface Early {
  response: Promise<Body>;
  controller: AbortController;
}

export class EarlySource implements RangedByteSource {
  #inner: RangedByteSource;
  #early = new Map<string, Early>();

  constructor(inner: RangedByteSource) {
    this.#inner = inner;
  }

  // Tied to no caller: it lives until a fetch claims it or the source drops it.
  sendWhole(path: string, cap: number): void {
    this.#send(wholeKey(path, cap), (signal) => this.#inner.fetchWhole(path, cap, { signal }));
  }

  // Tied to the sender's signal; the returned release drops the response if
  // nothing claimed it (a duplicate send gets a no-op).
  sendRange(path: string, start: number, length: number, signal?: AbortSignal): () => void {
    const key = rangeKey(path, start, length);
    const early = this.#send(key, (s) => this.#inner.fetchRange(path, start, length, { signal: s }), signal);
    return () => {
      if (early === undefined || this.#early.get(key) !== early) return;
      this.#early.delete(key);
      drop(early);
    };
  }

  // Drop every response nothing claimed: one still in flight is cancelled,
  // one that arrived is reported unused.
  dropUnclaimed(): void {
    for (const early of this.#early.values()) drop(early);
    this.#early.clear();
  }

  fetchWhole(path: string, cap: number, opts: { signal?: AbortSignal } = {}): Promise<Body> {
    const fresh = () => this.#inner.fetchWhole(path, cap, opts);
    return this.#claim(wholeKey(path, cap), opts.signal, fresh) ?? fresh();
  }

  fetchRange(path: string, start: number, length: number, opts: { signal?: AbortSignal } = {}): Promise<Body> {
    const fresh = () => this.#inner.fetchRange(path, start, length, opts);
    return this.#claim(rangeKey(path, start, length), opts.signal, fresh) ?? fresh();
  }

  #send(key: string, request: (signal: AbortSignal) => Promise<Body>, signal?: AbortSignal): Early | undefined {
    if (this.#early.has(key)) return undefined;
    const controller = new AbortController();
    const response = request(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    response.catch(() => {}); // an unclaimed failure is nobody's error
    const early = { response, controller };
    this.#early.set(key, early);
    return early;
  }

  // The claimant owns the request from here: its abort cancels it, only a
  // failure it did not cause sends the request again, and the body it gets
  // is its to judge.
  #claim(key: string, signal: AbortSignal | undefined, fresh: () => Promise<Body>): Promise<Body> | undefined {
    const early = this.#early.get(key);
    if (early === undefined) return undefined;
    this.#early.delete(key);
    if (signal?.aborted) early.controller.abort(signal.reason);
    signal?.addEventListener('abort', () => early.controller.abort(signal.reason), { once: true });
    return early.response.catch((err) => {
      if (signal?.aborted) throw err;
      return fresh();
    });
  }
}

function drop(early: Early): void {
  early.controller.abort();
  void early.response.then((body) => body.settle('unused'), () => {});
}

const wholeKey = (path: string, cap: number) => `whole:${path}<=${cap}`;
const rangeKey = (path: string, start: number, length: number) => `range:${path}:${start}+${length}`;
