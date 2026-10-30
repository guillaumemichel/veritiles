// veritiles' VerifiedFile: the ranged file with hints on by default (SPEC
// §5), its documents named by URL, as veritiles has always read files.

import { hints } from './hints.ts';
import { VerifiedFile as RangedFile, type VerifiedFileOptions as RangedFileOptions } from './verified-file.ts';

export interface VerifiedFileOptions extends Omit<RangedFileOptions, 'hints'> {
  /**
   * Routing-hints document URL(s), untrusted (SPEC §5). An explicit document
   * is consulted for every CID, fetched in the background from the open on;
   * its URLs follow the configured ones. The default (`./hints.json` beside
   * the page) is consulted only for a CID with nothing configured. Every
   * hinted byte is verified against the anchor exactly as a configured one.
   */
  hints?: string | string[];
}

export class VerifiedFile extends RangedFile {
  constructor(options: VerifiedFileOptions) {
    super({ ...options, hints: hints(options.hints) });
  }
}
