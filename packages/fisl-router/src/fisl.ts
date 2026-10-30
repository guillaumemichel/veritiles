// A router over a FISL index: look a CID up and yield the URLs the index
// names alongside the page's own locations, as each arrives. Every byte is
// still verified by the reader: a wrong or lying index costs a request,
// never a wrong byte. `select` lets a router built on this one pick and
// order the URLs from the records, using the index's own extensions.

import type { Router } from '@anymirror/router';

import { type FislRecord, readRecords } from './records.ts';

export interface FislOptions {
  /** The index's URL, such as `https://index.example`. */
  url: string;
  /** The fetch for lookups (default: global fetch); content goes through the client's own. */
  fetchFn?: typeof fetch;
  /**
   * The URLs to try for a CID, best first, from its live records. Read
   * lazily: the next URL is taken only when the reader needs another.
   * Default: each record's URLs, round by round.
   */
  select?: (records: FislRecord[], cid: string) => Iterable<string>;
}

// How long a lookup may take, and a request the router carries may wait for
// its answer to start: a host that never answers must not hold a read forever.
const ANSWER_TIMEOUT_MS = 10_000;

const everyRecord = (records: FislRecord[]) => interleave(records.map(({ urls }) => urls));

export function fisl({ url, fetchFn, select = everyRecord }: FislOptions): Required<Router> {
  const base = url.replace(/\/+$/, '');
  const lookupFetch = fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  // The index's URLs for a CID. A lookup that fails, or is closed, yields nothing.
  async function* lookup(cid: string, closed: AbortSignal): AsyncGenerator<string> {
    let records: FislRecord[];
    try {
      records = await withDeadline(closed, async (signal) => {
        const res = await lookupFetch(`${base}/routing/locations/${cid}/jsonl`, { signal });
        if (res.ok) return readRecords(res);
        void res.body?.cancel();
        return [];
      });
    } catch {
      return;
    }
    yield* select(records, cid);
  }

  return {
    // The page's own locations race the lookup, each tried as it arrives: a
    // configured page is served by its own hosts at once, and an anchor-only
    // page waits for no hints document before the lookup.
    async *locate(cid, { defaults }) {
      const closing = new AbortController();
      try {
        yield* race([defaults, lookup(cid, closing.signal)]);
      } finally {
        closing.abort();
      }
    },

    // Gives up on an answer that has not started in time.
    fetch(url, init, { next }) {
      return withDeadline(init.signal ?? undefined, (signal) => next(url, { ...init, signal }));
    },
  };
}

// Each group's first, then each one's second, and so on, so that one group
// with many URLs cannot crowd the others out. Each round keeps only the
// groups with URLs left, so a long one costs nothing per short one.
export function interleave(groups: string[][]): string[] {
  const out: string[] = [];
  let left = groups;
  for (let round = 0; left.length; round++) {
    left = left.filter((urls) => round < urls.length);
    for (const urls of left) out.push(urls[round]!);
  }
  return out;
}

// Values from every stream as they arrive, each stream read on only once
// its last value was taken. A stream that throws ends; closing the race
// closes them all.
async function* race<T>(streams: AsyncIterable<T>[]): AsyncGenerator<T> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const step = (i: number) =>
    iterators[i]!.next().then(
      (result) => ({ i, result }),
      () => ({ i, result: { done: true, value: undefined } as IteratorResult<T> }),
    );
  const pending = new Map(iterators.map((_, i) => [i, step(i)]));
  try {
    while (pending.size) {
      const { i, result } = await Promise.race(pending.values());
      pending.delete(i);
      if (result.done) continue;
      yield result.value;
      pending.set(i, step(i));
    }
  } finally {
    for (const iterator of iterators) void iterator.return?.()?.catch(() => {});
  }
}

// Runs `work` with a signal that aborts with the caller's, or once the work
// has taken ANSWER_TIMEOUT_MS, whichever comes first.
async function withDeadline<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('no answer in time', 'TimeoutError')), ANSWER_TIMEOUT_MS);
  try {
    return await work(signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]));
  } finally {
    clearTimeout(timer);
  }
}
