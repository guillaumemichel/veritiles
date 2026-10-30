// A fetch that records requests in the order they are ISSUED and holds each
// response until the test releases it — for asserting what a client sends
// before any answer arrives. Wraps any responder (e.g. servePackage's fetch).
// Labels are the URL, plus ` bytes=a-b` for a ranged request.

import type { FetchFn } from '../../packages/anymirror/src/routing.ts';

interface Held {
  label: string;
  go: () => void;
}

export interface GatedFetch {
  fetchFn: FetchFn;
  /** Every request label, in issue order. */
  issued: string[];
  /** Labels of held requests whose signal aborted them. */
  aborted: string[];
  /** Let every held request with this label through (all, without one). */
  release: (label?: string) => void;
  /** Hold new requests (the default) or let everything through. */
  hold: (on: boolean) => void;
  /** Resolve once `cond` holds; fail after two seconds. */
  until: (cond: () => boolean, what?: string) => Promise<void>;
}

export function gatedFetch(inner: FetchFn, { holds = () => true }: { holds?: (label: string) => boolean } = {}): GatedFetch {
  const issued: string[] = [];
  const aborted: string[] = [];
  let held: Held[] = [];
  let holding = true;

  const wait = (label: string, signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      const entry = { label, go: resolve };
      held.push(entry);
      signal?.addEventListener('abort', () => {
        held = held.filter((h) => h !== entry);
        aborted.push(label);
        reject(signal.reason);
      }, { once: true });
    });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const label = range ? `${String(input)} ${range}` : String(input);
    issued.push(label);
    if (holding && holds(label)) await wait(label, init?.signal ?? undefined);
    return inner(input, init);
  }) as FetchFn;

  const release = (label?: string) => {
    const go = held.filter((h) => label === undefined || h.label === label);
    held = held.filter((h) => !go.includes(h));
    for (const h of go) h.go();
  };

  return {
    fetchFn,
    issued,
    aborted,
    release,
    hold: (on) => {
      holding = on;
      if (!on) release();
    },
    until: async (cond, what = 'condition') => {
      const deadline = Date.now() + 2000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; issued: ${issued.join(', ')}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

// Give a client blocked on held responses time to show it sends nothing more.
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
