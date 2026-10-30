// The mp4 profile against tools/pack.ts: auto detection and leaf cuts on the
// box sequences of tools/gen-rust-vectors.ts, and CLI packs recorded from
// the TS packer. Byte-for-byte agreement over a wider corpus is
// test/pack-diff.test.ts.
mod common;

use anymirror_pack::plan::mp4::{is_fragmented_mp4, leaf_spans};
use common::run::{Dir, fails};
use common::{Json, fixture, hex, sha256, unhex};

#[test]
fn mp4_vectors() {
    for case in fixture("mp4.json").at("cases").arr() {
        let name = case.at("name").str();
        let bytes = unhex(case.at("bytes").str());
        assert_eq!(is_fragmented_mp4(&bytes), case.at("detected").bool(), "{name}: detected");
        let result = leaf_spans(&bytes);
        if let Some(error) = case.get("error") {
            assert_eq!(result.unwrap_err().0, error.str(), "{name}");
            continue;
        }
        let spans = result.unwrap_or_else(|e| panic!("{name}: {e}"));
        let cuts: Vec<u64> = case.at("cuts").arr().iter().map(Json::u64).collect();
        assert_eq!(spans.iter().map(|&(_, length)| length).collect::<Vec<_>>(), cuts, "{name}");
        let offsets = spans.iter().scan(0, |next, &(_, length)| Some(std::mem::replace(next, *next + length)));
        assert!(spans.iter().map(|&(offset, _)| offset).eq(offsets), "{name}: spans are contiguous from 0");
    }
}

fn mp4_box(kind: &[u8; 4], payload: usize) -> Vec<u8> {
    let mut out = (8 + payload as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend((0..payload).map(|i| (i * 31 % 251) as u8));
    out
}

// An init section, a 5 KB and a 300 KB fragment (across a 256 KiB UnixFS
// chunk), and an mfra: 305,560 bytes.
fn fragmented() -> Vec<u8> {
    let boxes = [(b"ftyp", 16), (b"moov", 300), (b"sidx", 40), (b"moof", 50), (b"mdat", 5000)];
    let rest = [(b"moof", 60), (b"mdat", 300_000), (b"mfra", 30)];
    boxes.into_iter().chain(rest).flat_map(|(kind, payload)| mp4_box(kind, payload)).collect()
}

#[test]
fn packs_a_fragmented_mp4_from_the_cli() {
    let dir = Dir::new("mp4-pack");
    dir.write("v.mp4", &fragmented());
    // Recorded from tools/pack.ts on the same file.
    let anchor = "bafyreid7e5ica2sflchdkinjyhbihy5w4bhfudti4ihkswj75pdiz7673e";
    let run = dir.run("v.mp4");
    assert_eq!((run.status, run.stdout.as_str()), (0, format!("{anchor}\n").as_str()));
    let summary = "proofs: v.mp4.proofs/ (4 leaves, 2 files, descriptor 110 bytes)\n";
    let map = "map: bafkr4iha22h7s4w3jec6yqr4tjljrowon4tqd3k6em3f5ssnmqjdps2w7m\n";
    assert_eq!(run.stderr, format!("{summary}{map}"));
    let run = dir.run("v.mp4 --profile mp4 --unixfs --full-car pin.car --out p2");
    assert_eq!((run.status, run.stdout.as_str()), (0, "bafyreibsrfj26wcvkephdzzix4xignjywly7ynce67xv773yllasazakte\n"));
    let summary = "proofs: p2/ (4 leaves, 2 files, descriptor 158 bytes)\n";
    let unixfs = "unixfs: bafybeiglgb45lavtkdhkyyjnwvill73fnmuhgnsleox7pzkgxxcflt5ryu\n";
    assert_eq!(run.stderr, format!("{summary}{map}{unixfs}"));
    assert_eq!(hex(&sha256(&dir.read("pin.car"))), "a21e6552703325b73d557196638567d75c311e26a55a2375e07b5f7dd539be63");
    let verified = dir.run(&format!("verify --cid {anchor} --file v.mp4 --proofs v.mp4.proofs"));
    assert_eq!((verified.status, verified.stdout.as_str()), (0, "verify OK\n"));
}

#[test]
fn profile_selection_and_errors() {
    let dir = Dir::new("mp4-errors");
    let video = fragmented();
    dir.write("v.mp4", &video);
    dir.write("t.mp4", &video[..video.len() - 1]);
    dir.write("r.mp4", &[mp4_box(b"ftyp", 16), mp4_box(b"moov", 300), mp4_box(b"mdat", 5000)].concat());
    let chunk = "--chunk applies only to the fixed profile";
    let tile_group = "--tile-group applies only to the pmtiles profile";
    fails(&dir.run("v.mp4 --chunk 1K"), chunk);
    fails(&dir.run("v.mp4 --profile mp4 --chunk 1K --tile-group 1K"), chunk);
    fails(&dir.run("v.mp4 --tile-group 1K"), tile_group);
    // A truncated download: detected by its first fragment, then the walk fails.
    fails(&dir.run("t.mp4"), "MP4 box at 305522 extends past the end of the file");
    // A regular MP4 packs as fixed, unless mp4 is forced.
    let run = dir.run("r.mp4 --out p3");
    assert_eq!((run.status, run.stdout.as_str()), (0, "bafyreibckbc476j4x5mel322agpep46raqj6cbigrhyk6ofemnn5ylkrlu\n"));
    assert!(run.stderr.starts_with("proofs: p3/ (1 leaves, 2 files, descriptor 108 bytes)\n"), "{}", run.stderr);
    fails(&dir.run("r.mp4 --profile mp4 --out p4"), "not a fragmented MP4: no moof box");
    assert!(!dir.0.join("p4").exists());
}
