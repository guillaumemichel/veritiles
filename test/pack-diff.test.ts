// Differential test: the Rust packer (packer/) must match tools/pack.ts byte
// for byte — exit status, stdout, stderr, and every output file — over the
// corpus in test/helpers/pack-corpus.ts. Runs as `npm run test:diff`, not
// in `npm test`. Skips until the release binary is built (`cargo build
// --release --manifest-path packer/Cargo.toml`), but fails in CI. Cases run
// concurrently.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PackCase } from './helpers/pack-corpus.ts';
import { packCorpus } from './helpers/pack-corpus.ts';
import { verifyCorpus } from './helpers/pack-corpus-verify.ts';
import { runPacker } from './helpers/pack-runner.ts';

const rustBin = fileURLToPath(new URL('../packer/target/release/anymirror-pack', import.meta.url));
const tsPack = [process.execPath, fileURLToPath(new URL('../tools/pack.ts', import.meta.url))];
const missing = `Rust packer not built: ${rustBin} is missing`;
if (process.env.CI && !existsSync(rustBin)) throw new Error(missing);
const skip = existsSync(rustBin) ? false : missing;

// Each case runs two CLIs, and the TS one uses more than a core.
const concurrency = Math.max(1, Math.floor(availableParallelism() / 2));

async function compare(packCase: PackCase): Promise<void> {
  const [ts, rs] = await Promise.all([runPacker(tsPack, packCase), runPacker([rustBin], packCase)]);
  assert.equal(rs.status, ts.status, `exit status (ts stderr: ${ts.stderr}, rust stderr: ${rs.stderr})`);
  assert.equal(ts.status === 0, !packCase.name.endsWith('(error)'), `TS exit status ${ts.status} contradicts the case name`);
  assert.equal(rs.stdout, ts.stdout, 'stdout');
  if (!packCase.statusOnly) assert.equal(rs.stderr, ts.stderr, 'stderr');
  assert.deepEqual([...rs.files.keys()].sort(), [...ts.files.keys()].sort(), 'output file set');
  for (const [path, bytes] of ts.files) {
    assert.ok(Buffer.compare(rs.files.get(path)!, bytes) === 0, `${path} differs`);
  }
}

describe('pack diff', { concurrency }, () => {
  // Verify cases need packages packed by both CLIs first, the slowest step
  // of the suite, so they come first and pack while the other cases run.
  test('D verify', { skip, concurrency }, async (t) => {
    const cases = await verifyCorpus({ ts: tsPack, rust: [rustBin] });
    await Promise.all(cases.map((packCase) => t.test(`D ${packCase.name}`, () => compare(packCase))));
  });
  for (const packCase of packCorpus()) {
    test(`D ${packCase.name}`, { skip }, () => compare(packCase));
  }
});
