// The `mp4` profile: the top-level box walk and its errors, one leaf per
// fragment, detection under `--profile auto`, and what it buys a player —
// a fragment read at its sidx range fetches exactly that fragment.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFragmentedMp4, mp4Cuts, pack, packMp4, verifyBytes } from '../tools/pack.ts';
import { VerifiedFile } from '../packages/anymirror/src/verified-file.ts';
import { deterministicBytes } from './helpers/bytes.ts';
import { box, concat, fragment, header, largeBox, openBox } from './helpers/mp4-writer.ts';
import { servePackage } from './helpers/serve-file.ts';

const ftyp = box('ftyp', 16);
const moov = box('moov', 300);
const init = concat(ftyp, moov, box('sidx', 40));
const frag = fragment(50, 1000);
const styp = box('styp', 12);
const emsg = box('emsg', 20);
const prft = box('prft', 24);
const fragmented = concat(init, frag, fragment(60, 2000), box('mfra', 30));
const regular = concat(ftyp, moov, box('mdat', 3000));

test('MP4-01 the init section, each fragment and the tail are one leaf each', () => {
  assert.deepEqual(mp4Cuts(fragmented), [init.length, frag.length, fragment(60, 2000).length, 38]);
  // Without boxes after the last mdat there is no tail leaf.
  assert.deepEqual(mp4Cuts(concat(init, frag, frag)), [init.length, frag.length, frag.length]);
});

test('MP4-02 styp, emsg and prft travel with the fragment they open', () => {
  const file = concat(ftyp, moov, styp, emsg, prft, frag, styp, frag, prft, emsg, frag);
  const expected = [ftyp.length + moov.length, 80 + frag.length, styp.length + frag.length, 60 + frag.length];
  assert.deepEqual(mp4Cuts(file), expected);
  // At the start of the file they open the first fragment: no init leaf.
  assert.deepEqual(mp4Cuts(concat(styp, frag)), [styp.length + frag.length]);
  assert.deepEqual(mp4Cuts(frag), [frag.length]);
});

test('MP4-03 a fragment keeps all its mdat boxes; any other box after an mdat opens the next leaf', () => {
  const file = concat(init, box('moof', 50), box('mdat', 100), box('mdat', 200), box('free', 8), frag);
  assert.deepEqual(mp4Cuts(file), [init.length, 58 + 108 + 208, 16 + frag.length]);
});

test('MP4-04 media before the first fragment stays in the init leaf', () => {
  const hybrid = concat(ftyp, moov, box('mdat', 500));
  assert.deepEqual(mp4Cuts(concat(hybrid, frag)), [hybrid.length, frag.length]);
  assert.deepEqual(mp4Cuts(concat(hybrid, styp, frag)), [hybrid.length, styp.length + frag.length]);
});

test('MP4-05 64-bit sizes and a last box of size 0', () => {
  const file = concat(init, box('moof', 50), largeBox('mdat', 1000), largeBox('moof', 40), openBox('mdat', 700));
  assert.deepEqual(mp4Cuts(file), [init.length, 58 + 1016, 56 + 708]);
});

test('MP4-06 a malformed box is an error naming its offset; a file without moof is not fragmented MP4', () => {
  const head = concat(init, frag);
  const at = head.length;
  const cases: [Uint8Array, string][] = [
    [concat(head, new Uint8Array(7)), `MP4 box at ${at} has a truncated header`],
    [concat(head, header('mdat', 1)), `MP4 box at ${at} has a truncated header`],
    [concat(head, header('mdat', 7)), `MP4 box at ${at} has an invalid size`],
    [concat(head, header('mdat', 1, 15n)), `MP4 box at ${at} has an invalid size`],
    [concat(head, header('mdat', 9)), `MP4 box at ${at} extends past the end of the file`],
    // The high word counts: read alone, the low word would fit exactly.
    [concat(head, header('mdat', 1, 2n ** 32n + 16n)), `MP4 box at ${at} extends past the end of the file`],
    [concat(head, header('mdat', 1, 2n ** 53n)), `MP4 box at ${at} extends past the end of the file`],
    [concat(head, header('mdat', 1, 2n ** 64n - 1n)), `MP4 box at ${at} extends past the end of the file`],
    [header('ftyp', 3), 'MP4 box at 0 has an invalid size'],
    // A walk error comes before the missing moof.
    [concat(ftyp, header('moov', 1000)), 'MP4 box at 24 extends past the end of the file'],
    [regular, 'not a fragmented MP4: no moof box'],
    [new Uint8Array(0), 'not a fragmented MP4: no moof box'],
  ];
  for (const [file, message] of cases) assert.throws(() => mp4Cuts(file), { message });
});

test('MP4-07 auto detection: an ftyp box first, then a top-level moof before the walk ends', () => {
  assert.equal(isFragmentedMp4(fragmented), true);
  // A malformed box after the first moof is still fragmented MP4: packing reports it.
  assert.equal(isFragmentedMp4(concat(init, frag, header('mdat', 99))), true);
  const others: [string, Uint8Array][] = [
    ['a regular MP4', regular],
    ['no ftyp first', concat(moov, frag)],
    ['a moof inside a box', concat(ftyp, box('moov', frag))],
    ['a malformed box before the first moof', concat(ftyp, header('moov', 3), frag)],
    ['ftyp, then garbage', concat(ftyp, deterministicBytes(5000, 3))],
    ['a size-0 ftyp', openBox('ftyp', frag)],
    ['a truncated ftyp header', ftyp.subarray(0, 7)],
    ['an empty file', new Uint8Array(0)],
  ];
  for (const [name, file] of others) assert.equal(isFragmentedMp4(file), false, name);
});

test('MP4-08 auto picks mp4 for fragmented MP4 and fixed for anything else', async () => {
  const auto = await pack(fragmented);
  assert.deepEqual(auto.cuts, mp4Cuts(fragmented));
  assert.equal(auto.leafCount, 4);
  assert.equal(auto.tileGroupBytes, undefined);
  assert.equal(await verifyBytes(auto.anchor, fragmented, auto.proofs), 32);
  assert.deepEqual(await packMp4(fragmented), auto);
  for (const file of [regular, frag, concat(ftyp, deterministicBytes(5000, 3))]) {
    const fixed = await pack(file);
    assert.equal(fixed.cuts, undefined);
    assert.equal(fixed.leafCount, 1);
  }
  const overridden = await pack(fragmented, { profile: 'fixed', chunkSize: 1024 });
  assert.equal(overridden.leafCount, Math.ceil(fragmented.length / 1024));
});

test('MP4-09 the mp4 profile is strict', async () => {
  const truncated = fragmented.subarray(0, fragmented.length - 1);
  await assert.rejects(pack(truncated), { message: `MP4 box at ${fragmented.length - 38} extends past the end of the file` });
  await assert.rejects(pack(regular, { profile: 'mp4' }), { message: 'not a fragmented MP4: no moof box' });
  assert.deepEqual((await pack(frag, { profile: 'mp4' })).cuts, [frag.length]);
  const chunk = { message: '--chunk applies only to the fixed profile' };
  const tileGroup = { message: '--tile-group applies only to the pmtiles profile' };
  await assert.rejects(pack(fragmented, { chunkSize: 1024 }), chunk);
  await assert.rejects(pack(fragmented, { profile: 'mp4', chunkSize: 1024 }), chunk);
  await assert.rejects(pack(fragmented, { tileGroupBytes: 0 }), tileGroup);
  await assert.rejects(pack(fragmented, { profile: 'mp4', tileGroupBytes: 1024 }), tileGroup);
  await assert.rejects(pack(fragmented, { chunkSize: 1024, tileGroupBytes: 1024 }), chunk);
  await assert.rejects(pack(truncated, { profile: 'mp4', chunkSize: 1024 }), chunk);
});

test('MP4-10 a fragment read at its sidx range fetches exactly that fragment', async () => {
  const FILE = 'https://h/video.mp4';
  const fragments = [fragment(50, 3000), fragment(70, 9000), fragment(40, 500)];
  const file = concat(init, ...fragments, box('mfra', 30));
  const packed = await packMp4(file);
  const ranges: string[] = [];
  const onRequest = (url: string, headers?: Record<string, string>) => {
    if (url === FILE) ranges.push(headers?.Range ?? '');
  };
  const vf = new VerifiedFile({ cid: packed.anchor, source: FILE, fetchFn: servePackage(FILE, file, packed.proofs, { onRequest }).fetch });
  const expected: string[] = [];
  let offset = init.length;
  for (const bytes of fragments) {
    assert.deepEqual(await vf.read(offset, bytes.length), bytes);
    expected.push(`bytes=${offset}-${offset + bytes.length - 1}`);
    offset += bytes.length;
  }
  assert.deepEqual(ranges, expected);
});
