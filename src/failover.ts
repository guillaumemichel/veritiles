// Failover (SPEC §4): one fetch of a CID's bytes, tried at its locations
// until one serves. A location that serves wrong bytes for a CID is banned
// for that CID for the client's session; one that fails in transport is
// demoted — tried after the others, least recently failed first, until it
// serves again. Before going back to a demoted location a fetch asks the
// router for a fresh one, and it gives up after 16 failures. The first
// request goes out synchronously when a location is held.

import { MAX_FAILED_LOCATIONS } from './limits.ts';
import type { Locations } from './locations.ts';
import { VerificationError } from './verify.ts';

interface FailoverOptions {
  signal?: AbortSignal;
  /** Ask the router for a fresh location when the held ones run out; speculation never does. */
  fresh?: boolean;
  /** What wrong bytes cost a location besides its demotion: a ban for the CID, or nothing. */
  rejected?: 'ban' | 'demote';
}

// One client's faults. A ban is per CID: a URL that served wrong bytes for
// one CID may be another's right location, so for the others it is only
// demoted. Demoted locations are kept least recently failed first.
export class Faults {
  #banned = new Set<string>();
  #demoted = new Set<string>();

  banned(cid: string, location: string): boolean {
    return this.#banned.has(`${cid} ${location}`);
  }

  demoted(location: string): boolean {
    return this.#demoted.has(location);
  }

  // The least recently failed demoted location that passes `usable`.
  firstDemoted(usable: (location: string) => boolean): string | undefined {
    for (const location of this.#demoted) if (usable(location)) return location;
    return undefined;
  }

  record(cid: string, location: string, err: unknown, rejected: 'ban' | 'demote'): void {
    if (err instanceof VerificationError && rejected === 'ban') this.#banned.add(`${cid} ${location}`);
    this.#demoted.delete(location);
    this.#demoted.add(location);
  }

  served(location: string): void {
    this.#demoted.delete(location);
  }
}

export async function failover<T>(
  locations: Locations,
  attempt: (location: string) => Promise<T>,
  { signal, fresh = true, rejected = 'ban' }: FailoverOptions = {},
): Promise<T> {
  const { cid, faults } = locations;
  const tried = new Set<string>();
  const usable = (location: string) => !tried.has(location) && !faults.banned(cid, location);
  const errors: unknown[] = [];
  while (errors.length < MAX_FAILED_LOCATIONS) {
    let location = locations.held().find((held) => usable(held) && !faults.demoted(held));
    if (location === undefined && fresh && !locations.ended()) {
      await locations.pull(signal);
      continue;
    }
    location ??= faults.firstDemoted((demoted) => usable(demoted) && locations.held().includes(demoted));
    if (location === undefined) break;
    tried.add(location);
    try {
      const result = await attempt(location);
      faults.served(location);
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      faults.record(cid, location, err, rejected);
      errors.push(err);
    }
  }
  locations.exhausted();
  if (!locations.held().length) throw locations.unlocated();
  throw new AggregateError(errors, `all sources failed for ${cid}`);
}
