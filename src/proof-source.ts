// Proof loading for a manifest CAR. Only the manifest root is required;
// optional raw sections are opportunistic content candidates.

import { type Cid, DAG_CBOR_CODE } from './cid.ts';
import { type BagSection, type CarBag, parseCarBag } from './car.ts';
import { decodeManifest, type Manifest } from './manifest.ts';
import type { FetchFn } from './range-source.ts';
import { readBody } from './read-body.ts';
import type { VerifyStats } from './verified-store.ts';
import { equalBytes, sha256, toHex, VerificationError } from './verify.ts';

interface LoadedBag { gen: number; urlIndex: number; bag: CarBag; }

export class ProofSource {
  #urls: string[]; #fetchFn: FetchFn; #maxProofBytes: number; #stats: VerifyStats;
  #order: number[]; #next = 0; #faults: number[]; #bag: LoadedBag | undefined; #gen = 0;
  #loading: Promise<LoadedBag | undefined> | undefined; #rootMemo: Manifest | undefined;
  #rootPromise: Promise<Manifest> | undefined; #discarded = new Set<string>();

  constructor(urls: string[], opts: { fetchFn: FetchFn; maxProofBytes: number; stats: VerifyStats }) {
    if (!urls.length) throw new Error('at least one proof URL is required');
    this.#urls = urls; this.#fetchFn = opts.fetchFn; this.#maxProofBytes = opts.maxProofBytes; this.#stats = opts.stats;
    this.#order = urls.map((_, index) => index); this.#faults = urls.map(() => 0);
  }

  root(anchor: Cid): Promise<Manifest> {
    if (this.#rootMemo !== undefined) return Promise.resolve(this.#rootMemo);
    if (this.#rootPromise === undefined) {
      this.#rootPromise = this.#resolveRoot(anchor);
      this.#rootPromise.catch(() => undefined).finally(() => { this.#rootPromise = undefined; });
    }
    return this.#rootPromise;
  }

  leafCandidate(digestHex: string): Uint8Array | undefined {
    if (this.#discarded.has(digestHex)) return undefined;
    const section = this.#bag?.bag.get(digestHex);
    return section?.codec === 0x55 ? section.bytes : undefined;
  }

  discardLeafCandidate(digestHex: string): void { this.#discarded.add(digestHex); }

  async #resolveRoot(anchor: Cid): Promise<Manifest> {
    if (anchor.codec !== DAG_CBOR_CODE) throw new VerificationError('proof: manifest anchor must be dag-cbor');
    const digestHex = toHex(anchor.digest); const errors: unknown[] = [];
    for (;;) {
      const loaded = await this.#ensureBag(errors);
      if (loaded === undefined) { this.#reset(); throw new AggregateError(errors, 'proof: all sources failed'); }
      const section: BagSection | undefined = loaded.bag.get(digestHex);
      if (section === undefined) { this.#fault(loaded, errors, new VerificationError('proof: root block missing')); continue; }
      if (section.codec !== DAG_CBOR_CODE || !equalBytes(await sha256(section.bytes), anchor.digest)) { this.#fault(loaded, errors, new VerificationError('proof: root block does not match the anchor')); continue; }
      try {
        const manifest = decodeManifest(section.bytes);
        this.#stats.verified++; this.#rootMemo = manifest; return manifest;
      } catch (err) {
        if (!(err instanceof VerificationError)) throw err;
        this.#fault(loaded, errors, err);
      }
    }
  }

  #ensureBag(errors: unknown[]): Promise<LoadedBag | undefined> {
    if (this.#bag !== undefined) return Promise.resolve(this.#bag);
    if (this.#loading === undefined) this.#loading = this.#loadNext(errors).finally(() => { this.#loading = undefined; });
    return this.#loading;
  }

  async #loadNext(errors: unknown[]): Promise<LoadedBag | undefined> {
    while (this.#next < this.#order.length) {
      const urlIndex = this.#order[this.#next++]!; const url = this.#urls[urlIndex]!;
      let body: Uint8Array;
      try {
        const res = await this.#fetchFn(url);
        if (!res.ok) { void res.body?.cancel?.(); errors.push(new Error(`${url}: HTTP ${res.status}`)); continue; }
        body = await readBody(res, this.#maxProofBytes);
      } catch (err) {
        if (err instanceof VerificationError) { this.#stats.rejected++; this.#faults[urlIndex]!++; }
        errors.push(err); continue;
      }
      try { this.#bag = { gen: ++this.#gen, urlIndex, bag: parseCarBag(body, 'proof') }; return this.#bag; }
      catch (err) { this.#stats.rejected++; this.#faults[urlIndex]!++; errors.push(err); }
    }
    return undefined;
  }

  #fault(loaded: LoadedBag, errors: unknown[], err: VerificationError): void {
    if (this.#bag?.gen !== loaded.gen) { errors.push(err); return; }
    this.#stats.rejected++; this.#faults[loaded.urlIndex]!++; errors.push(err); this.#bag = undefined;
  }

  #reset(): void { this.#order.sort((a, b) => this.#faults[a]! - this.#faults[b]! || a - b); this.#next = 0; this.#bag = undefined; }
}
