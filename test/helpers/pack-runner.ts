// Runs one packer CLI over a corpus case in a fresh directory and captures
// everything observable: exit status, stdout, stderr, and every file the run
// created or changed. The CLI runs asynchronously so cases can run
// concurrently.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PackCase } from './pack-corpus.ts';

export const PACK_TIMEOUT_MS = 120_000;

export interface PackRun {
  status: number | null;
  /** The signal that ended the run: `SIGTERM` once it outlived PACK_TIMEOUT_MS. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  files: Map<string, Uint8Array>;
}

export async function runPacker(command: string[], packCase: PackCase): Promise<PackRun> {
  const dir = await mkdtemp(join(tmpdir(), 'anymirror-pack-diff-'));
  try {
    for (const [name, bytes] of Object.entries(packCase.inputs)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), bytes);
    }
    await packCase.setup?.(dir);
    const result = await run(command, packCase.args, dir);
    const files = await readTree(Buffer.from(dir));
    for (const [name, bytes] of Object.entries(packCase.inputs)) {
      if (Buffer.compare(files.get(name) ?? new Uint8Array(), bytes) === 0) files.delete(name);
    }
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8').replaceAll(dir, '<dir>'),
      files,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Exit { status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }

function run(command: string[], args: string[], cwd: string): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { cwd, timeout: PACK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

// Names are read as bytes (a case may hold a name that is not UTF-8) and
// keyed lossily; symlinks are inputs, never outputs, so they are skipped.
async function readTree(base: Buffer, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(base, { withFileTypes: true, encoding: 'buffer' })) {
    const path = `${prefix}${entry.name.toString('utf8')}`;
    const full = Buffer.concat([base, Buffer.from('/'), entry.name]);
    if (entry.isDirectory()) {
      for (const [sub, bytes] of await readTree(full, `${path}/`)) files.set(sub, bytes);
      continue;
    }
    if (entry.isFile()) files.set(path, new Uint8Array(await readFile(full)));
  }
  return files;
}
