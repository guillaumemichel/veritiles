// Proof loading for a bundle: a manifest CAR, or the bare manifest block (the
// anchor's own bytes — what a router may name). Only the manifest root is
// required; optional raw sections are opportunistic content candidates. A
// location that fails, in transport or with a bad proof, is demoted rather
// than banned: tried after the others, it may serve a later attempt.

import { type Cid, DAG_CBOR_CODE } from './cid.ts';
import { type CarBag, parseCarBag } from './car.ts';
import { failover } from './failover.ts';
import { DAG_CBOR_SECTION_CAP } from './limits.ts';
import type { Locations } from './locations.ts';
import { decodeManifest, type Manifest } from './manifest.ts';
import { type Body, verdictOf } from './verdict.ts';
import type { ByteSource, VerifyStats } from './verified-store.ts';
import { equalBytes, sha256, toHex, VerificationError } from './verify.ts';

export class ProofSource {
  #locations: Locations;
  #sourceFor: (location: string) => ByteSource;
  #maxProofBytes: number;
  #stats: VerifyStats;
  #bag: CarBag | undefined;
  #rootMemo: Manifest | undefined;
  #rootPromise: Promise<Manifest> | undefined;
  #discarded = new Set<string>();

  constructor(
    locations: Locations,
    opts: { sourceFor: (location: string) => ByteSource; maxProofBytes: number; stats: VerifyStats },
  ) {
    this.#locations = locations;
    this.#sourceFor = opts.sourceFor;
    this.#maxProofBytes = opts.maxProofBytes;
    this.#stats = opts.stats;
  }

  root(anchor: Cid): Promise<Manifest> {
    if (this.#rootMemo !== undefined) return Promise.resolve(this.#rootMemo);
    if (this.#rootPromise === undefined) {
      this.#rootPromise = this.#resolveRoot(anchor);
      this.#rootPromise.catch(() => undefined).finally(() => {
        this.#rootPromise = undefined;
      });
    }
    return this.#rootPromise;
  }

  leafCandidate(digestHex: string): Uint8Array | undefined {
    if (this.#discarded.has(digestHex)) return undefined;
    const section = this.#bag?.get(digestHex);
    return section?.codec === 0x55 ? section.bytes : undefined;
  }

  discardLeafCandidate(digestHex: string): void {
    this.#discarded.add(digestHex);
  }

  async #resolveRoot(anchor: Cid): Promise<Manifest> {
    if (anchor.codec !== DAG_CBOR_CODE) throw new VerificationError('proof: manifest anchor must be dag-cbor');
    const { bag, manifest } = await failover(this.#locations, (location) => this.#load(location, anchor), { rejected: 'demote' });
    this.#bag = bag;
    this.#rootMemo = manifest;
    return manifest;
  }

  // One location's proof, checked: the root block is there, hashes to the
  // anchor, and decodes as a manifest.
  async #load(location: string, anchor: Cid): Promise<{ bag: CarBag; manifest: Manifest }> {
    let body: Body | undefined;
    try {
      body = await this.#sourceFor(location).fetchWhole('', this.#maxProofBytes);
      const bag = await parseProof(body.bytes, anchor);
      const section = bag.get(toHex(anchor.digest));
      if (section === undefined) throw new VerificationError('proof: root block missing');
      if (section.codec !== DAG_CBOR_CODE || !equalBytes(await sha256(section.bytes), anchor.digest)) {
        throw new VerificationError('proof: root block does not match the anchor');
      }
      const manifest = decodeManifest(section.bytes);
      body.settle('verified');
      this.#stats.verified++;
      return { bag, manifest };
    } catch (err) {
      body?.settle(verdictOf(err, undefined));
      if (err instanceof VerificationError) this.#stats.rejected++;
      throw err;
    }
  }
}

// A body that hashes to the anchor is the bare manifest block; anything else
// must be a CAR bag holding it (SPEC §3.2).
async function parseProof(body: Uint8Array, anchor: Cid): Promise<CarBag> {
  if (body.length <= DAG_CBOR_SECTION_CAP && equalBytes(await sha256(body), anchor.digest)) {
    return new Map([[toHex(anchor.digest), { codec: DAG_CBOR_CODE, bytes: body }]]);
  }
  return parseCarBag(body, 'proof');
}
