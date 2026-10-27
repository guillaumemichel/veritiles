// Locations (SPEC §4, §6): where one CID's bytes may live, as its router
// yields them. The stream is read lazily — the next location only when a
// fetch has run out of the ones it holds — and what it yields is kept for
// the client's lifetime. A custom router's values are untrusted and checked
// like hints entries; what the built-in router names (the page's own
// configuration, hints already checked) passes as it is, even when a custom
// router hands it on. A router that fails only ends its stream; once the
// stream has ended and every location failed, the next pull asks again.

import { abortable } from './abortable.ts';
import { Faults } from './failover.ts';
import { resolveLocation } from './hints.ts';
import { MAX_LOCATED_VALUES } from './limits.ts';
import type { Router } from './router.ts';

// The built-in router as the locator sees it: a CID's configured locations
// at once, the rest (hinted, probed) as they come, and the hints documents
// it fetched, for the error naming an unlocated CID.
export interface DefaultLocations {
  open(cid: string, path?: string): { configured: string[]; rest: AsyncIterable<string> };
  consulted(): string[];
}

interface LocationsSpec {
  /** The class an unlocated CID is reported as. */
  kind: 'proof' | 'content';
  /** The CID as that error names it (default: its canonical text). */
  label?: string;
  /** A rule a router's location must also meet: a ranged file's anchor takes only `{proof}/root`. */
  accept?: (url: string) => boolean;
  /** A bundle file's manifest path, which its configured locations carry. */
  path?: string;
}

// One client's locations, one stream per CID, and how they fared.
export class Locator {
  #router: Router | undefined;
  #defaults: DefaultLocations;
  #faults = new Faults();
  #all = new Map<string, Locations>();

  constructor(router: Router | undefined, defaults: DefaultLocations) {
    this.#router = router;
    this.#defaults = defaults;
  }

  for(cid: string, spec: LocationsSpec): Locations {
    let locations = this.#all.get(cid);
    if (locations === undefined) {
      locations = new Locations(cid, spec, this.#router, this.#defaults, this.#faults);
      this.#all.set(cid, locations);
    }
    return locations;
  }
}

export class Locations {
  readonly cid: string;
  // The client's bans and demotions, kept per location (SPEC §4).
  readonly faults: Faults;
  #spec: LocationsSpec;
  #router: Router | undefined;
  #defaults: DefaultLocations;
  #held: string[] = [];
  #trusted = new Set<unknown>(); // values the built-in router produced, handed on by a custom one
  #stream!: AsyncIterator<unknown>;
  #read = 0; // values read from the current stream
  #state: 'open' | 'ended' | 'stale' = 'open';
  #pending: Promise<void> | undefined;

  constructor(cid: string, spec: LocationsSpec, router: Router | undefined, defaults: DefaultLocations, faults: Faults) {
    this.cid = cid;
    this.faults = faults;
    this.#spec = spec;
    this.#router = router;
    this.#defaults = defaults;
    this.#open();
  }

  // The locations read so far, in arrival order.
  held(): readonly string[] {
    return this.#held;
  }

  // True once the stream has nothing more to give, until it is renewed.
  ended(): boolean {
    return this.#state === 'ended';
  }

  // Read on until a new location arrives or the stream ends. Callers share
  // one read; an aborted caller stops waiting, the read goes on.
  pull(signal?: AbortSignal): Promise<void> {
    if (this.#state === 'stale') this.#open();
    if (this.#state === 'ended') return Promise.resolve();
    this.#pending ??= this.#advance();
    return abortable(this.#pending, signal);
  }

  // Every location failed: if the stream has ended, the next pull asks the
  // router again (a stream still open is simply read on).
  exhausted(): void {
    if (this.#state === 'ended') this.#state = 'stale';
  }

  unlocated(): Error {
    const consulted = [...this.#defaults.consulted(), ...(this.#router === undefined ? [] : ['the router'])];
    const where = consulted.length ? consulted.join(', ') : 'no hints documents';
    return new Error(`no ${this.#spec.kind} location for ${this.#spec.label ?? this.cid}; consulted ${where}`);
  }

  // Ask the router. The built-in one alone names its configured locations at
  // once; a custom one is asked on the first pull, with the built-in
  // router's stream as its defaults.
  #open(): void {
    this.#state = 'open';
    this.#read = 0;
    const { cid } = this;
    const { path } = this.#spec;
    const router = this.#router;
    if (router === undefined) {
      const { configured, rest } = this.#defaults.open(cid, path);
      for (const url of configured) this.#take(url);
      this.#stream = rest[Symbol.asyncIterator]();
      return;
    }
    const defaults = { [Symbol.asyncIterator]: () => this.#defaultsFor(cid, path) };
    this.#stream = answer(() => router.locate(cid, { defaults }));
  }

  // The built-in router's stream for this CID, each value marked as its own.
  async *#defaultsFor(cid: string, path: string | undefined): AsyncGenerator<string> {
    const { configured, rest } = this.#defaults.open(cid, path);
    for (const value of configured) {
      this.#trusted.add(value);
      yield value;
    }
    for await (const value of rest) {
      this.#trusted.add(value);
      yield value;
    }
  }

  async #advance(): Promise<void> {
    try {
      for (;;) {
        let step: IteratorResult<unknown>;
        try {
          step = await this.#stream.next();
        } catch {
          step = { done: true, value: undefined }; // a failing router ends its stream
        }
        if (step.done) {
          this.#state = 'ended';
          return;
        }
        const added = this.#take(step.value);
        if (++this.#read >= MAX_LOCATED_VALUES) {
          this.#state = 'ended';
          void this.#stream.return?.()?.catch(() => {});
          return;
        }
        if (added) return;
      }
    } finally {
      this.#pending = undefined;
    }
  }

  // Keep a value if it is a new location: the built-in router's as it is,
  // anything else only as an absolute http(s) URL the spec accepts.
  #take(value: unknown): boolean {
    const url = this.#router === undefined || this.#trusted.has(value) ? (value as string) : this.#check(value);
    if (url === null || this.#held.includes(url)) return false;
    this.#held.push(url);
    return true;
  }

  #check(value: unknown): string | null {
    const url = resolveLocation(value);
    return url !== null && (this.#spec.accept?.(url) ?? true) ? url : null;
  }
}

// A router's answer as one stream: an async iterable, an iterable, or a
// promise of one. Anything else, or a failure, ends it.
async function* answer(locate: () => unknown): AsyncGenerator<unknown> {
  const produced = await locate();
  if (typeof produced !== 'object' || produced === null) return;
  if (Symbol.asyncIterator in produced || Symbol.iterator in produced) yield* produced as AsyncIterable<unknown>;
}
