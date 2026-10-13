// Fragmented MP4 cases for the differential corpus: auto detection and the
// files it leaves to the fixed profile, explicit --profile mp4, segment
// boxes, 64-bit and open-ended sizes, malformed boxes, option misuse, and
// --unixfs with a full CAR.

import { deterministicBytes } from './bytes.ts';
import { box, concat, fragment, header, largeBox, openBox } from './mp4-writer.ts';
import type { PackCase } from './pack-corpus.ts';

const KiB = 1024;

const mp4Case = (name: string, bytes: Uint8Array, args: string[] = []): PackCase => ({
  name: `mp4 ${name}`,
  inputs: { 'video.mp4': bytes },
  args: ['video.mp4', '--out', 'proofs', ...args],
});

const ftyp = box('ftyp', 16);
const moov = box('moov', 700);
const init = concat(ftyp, moov, box('sidx', 64));
// Four fragments, 330 KiB of media: across a 256 KiB UnixFS chunk.
const fragments = concat(...[10, 80, 200, 40].map((size, i) => fragment(100 + 50 * i, size * KiB)));
const video = concat(init, fragments, box('mfra', 40));
const regular = concat(ftyp, moov, box('mdat', 300 * KiB));

// `count` fragments of about `size` bytes of media, each opened by boxes of
// the `segment` types.
function segments(count: number, size: number, segment: string[] = []): Uint8Array {
  const one = (i: number) => concat(...segment.map((type) => box(type, 8 + (i % 5))), fragment(60, size + (i % 97)));
  return concat(...Array.from({ length: count }, (_, i) => one(i)));
}

function wellFormed(): PackCase[] {
  return [
    mp4Case('auto profile', video),
    mp4Case('explicit profile', video, ['--profile', 'mp4']),
    mp4Case('fixed profile override', video, ['--profile', 'fixed', '--chunk', '64KiB']),
    mp4Case('CMAF: styp before every moof', concat(ftyp, moov, segments(6, 3000, ['styp']))),
    mp4Case('emsg and prft before every moof', concat(init, segments(6, 3000, ['emsg', 'prft']))),
    mp4Case('several mdat boxes per fragment, free boxes between fragments', concat(
      init, box('moof', 80), box('mdat', 5000), box('mdat', 7000), box('free', 16), fragment(80, 4000), box('skip', 4), fragment(80, 4000),
    )),
    mp4Case('hybrid: media before the first fragment', concat(ftyp, moov, box('mdat', 20 * KiB), fragments)),
    mp4Case('largesize boxes and a size-0 last mdat', concat(init, largeBox('moof', 100), largeBox('mdat', 30 * KiB), box('moof', 100), openBox('mdat', 20 * KiB))),
    // 3,000 fragments, over the 1,820 records of one shard.
    mp4Case('audio only: 3,000 small fragments', concat(ftyp, box('moov', 500), segments(3000, 250))),
    mp4Case('no ftyp, explicit profile', fragments, ['--profile', 'mp4']),
    mp4Case('--unixfs', video, ['--unixfs']),
    mp4Case('--unixfs, full CAR', video, ['--unixfs', '--full-car', 'pin.car']),
  ];
}

// Under `auto`, only an ftyp first and a top-level moof make an MP4 fragmented.
function fixedFallbacks(): PackCase[] {
  return [
    mp4Case('no ftyp packs as fixed', fragments),
    mp4Case('regular MP4 packs as fixed', regular),
    mp4Case('ftyp then garbage packs as fixed', concat(ftyp, deterministicBytes(50 * KiB, 3))),
    mp4Case('a moof inside a box packs as fixed', concat(ftyp, box('moov', fragments))),
    mp4Case('a malformed box before the first moof packs as fixed', concat(ftyp, header('moov', 3), fragments)),
  ];
}

function errors(): PackCase[] {
  const truncated = video.subarray(0, video.length - 100);
  return [
    mp4Case('regular MP4, explicit profile (error)', regular, ['--profile', 'mp4']),
    mp4Case('empty, explicit profile (error)', new Uint8Array(0), ['--profile', 'mp4']),
    mp4Case('truncated download (error)', truncated),
    mp4Case('truncated header (error)', concat(init, fragments, new Uint8Array(5))),
    mp4Case('truncated first header, explicit profile (error)', header('ftyp', 1), ['--profile', 'mp4']),
    mp4Case('invalid size, explicit profile (error)', concat(fragments, header('mdat', 7)), ['--profile', 'mp4']),
    mp4Case('largesize past the end (error)', concat(init, fragments, header('mdat', 1, 2n ** 32n + 16n))),
    mp4Case('--chunk (error)', video, ['--chunk', '1KiB']),
    mp4Case('--chunk, explicit profile (error)', video, ['--profile', 'mp4', '--chunk', '1KiB']),
    mp4Case('--tile-group (error)', video, ['--tile-group', '1KiB']),
    mp4Case('--chunk and --tile-group (error)', video, ['--profile', 'mp4', '--tile-group', '0', '--chunk', '1KiB']),
    mp4Case('--chunk on a truncated download (error)', truncated, ['--chunk', '1KiB']),
  ];
}

export function mp4Corpus(): PackCase[] {
  return [...wellFormed(), ...fixedFallbacks(), ...errors()];
}
