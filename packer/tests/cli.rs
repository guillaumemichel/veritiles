// End-to-end CLI checks against outputs recorded from tools/pack.ts. The
// byte-for-byte comparison over a wider corpus is test/pack-diff.test.ts.
mod common;

use std::fs;

use common::run::{Dir, fails};
use common::{hex, pattern, sha256};

fn sha256_hex(dir: &Dir, name: &str) -> String {
    hex(&sha256(&dir.read(name)))
}

#[test]
fn packs_one_shard() {
    let dir = Dir::new("one");
    dir.write("a.bin", &pattern(5000));
    let run = dir.run("a.bin --chunk 1K");
    assert_eq!(run.status, 0, "{}", run.stderr);
    assert_eq!(run.stdout, "bafyreihtczshy5zw3f6wrylxbttuumsmjctczcdxfuumk4nwmnqg6edqau\n");
    let summary = "proofs: a.bin.proofs/ (5 leaves, 2 files, descriptor 108 bytes)\nmap: bafkr4ias3ius4gclwb54iwnukfephka32dnrxiyzt56xm3kjprebnmxps4\n";
    assert_eq!(run.stderr, summary);
    assert_eq!(dir.files("a.bin.proofs"), ["0", "root"]);
    let root = sha256_hex(&dir, "a.bin.proofs/root");
    assert_eq!(root, "f316647c7736d97d68e1770ce74a324c48a62c88772d28c571b663606f107005");
}

#[test]
fn packs_several_shards() {
    let dir = Dir::new("several");
    dir.write("b.bin", &pattern(4000));
    let run = dir.run("b.bin --chunk 1 --out pb");
    assert_eq!(run.stdout, "bafyreiawzay5jsvtyezpzovwssonrvjhjtg22z4k64ree2b7x5cldb2iye\n");
    let summary = "proofs: pb/ (4000 leaves, 4 files, descriptor 190 bytes)\nmap: bafkr4idkr7kygk65c3loc5ad6mhd7wesay25marcivcmzre4723nrqzpaq\n";
    assert_eq!(run.stderr, summary);
    assert_eq!(dir.files("pb"), ["0", "71c", "e38", "root"]);
    let root = sha256_hex(&dir, "pb/root");
    assert_eq!(root, "16c831d4cab3c132fcbab6949cd8d5274ccdad678af72242683fbf44b18748c1");
}

#[test]
fn input_errors() {
    let dir = Dir::new("input");
    dir.write("empty.bin", b"");
    fs::create_dir(dir.0.join("dd")).unwrap();
    fails(&dir.run("missing.bin"), "ENOENT: no such file or directory, open 'missing.bin'");
    fails(&dir.run("dd"), "EISDIR: illegal operation on a directory, read");
    fails(&dir.run("empty.bin"), "invalid record length 0");
    assert!(!dir.0.join("empty.bin.proofs").exists());
}

#[test]
fn option_errors() {
    let dir = Dir::new("options");
    dir.write("a.bin", &pattern(100));
    let abs = dir.0.join("a.bin");
    fails(&dir.run(""), veritiles_pack::args::PACK_USAGE);
    fails(&dir.run("a.bin --out ./a.bin"), "--out resolves to the input file");
    fails(&dir.run(&format!("a.bin --unixfs --full-car {}", abs.display())), "--full-car resolves to the input file");
    fails(&dir.run("a.bin --out x/../a.bin/"), "--out resolves to the input file");
    fails(&dir.run("a.bin --profile pmtiles --chunk 1K"), "--chunk applies only to the fixed profile");
    fails(&dir.run("a.bin --profile nope --chunk 1K"), "unknown profile: nope");
    fails(&dir.run("a.bin --tile-group 1K"), "--tile-group applies only to the pmtiles profile");
    fails(&dir.run("a.bin --chunk 0"), "bad chunk size: 0");
    fails(&dir.run("a.bin --profile pmtiles"), "not a PMTiles v3 archive");
}

#[test]
fn pmtiles_magic_selects_the_pmtiles_profile() {
    let dir = Dir::new("pmtiles");
    dir.write("m.pmtiles", b"PMTiles\x03");
    fails(&dir.run("m.pmtiles"), "truncated PMTiles header");
    fails(&dir.run("m.pmtiles --chunk 1K"), "--chunk applies only to the fixed profile");
    fails(&dir.run("m.pmtiles --profile fixed --chunk 0"), "bad chunk size: 0");
}

#[test]
fn subcommand_usage() {
    let dir = Dir::new("sub");
    fails(&dir.run("assets"), veritiles_pack::args::ASSETS_USAGE);
    fails(&dir.run("assets d --type x"), "bad --type x");
    fails(&dir.run("verify --cid x"), veritiles_pack::args::VERIFY_USAGE);
}

#[test]
fn packs_unixfs_with_a_full_car() {
    let dir = Dir::new("unixfs");
    // Three identical 256 KiB chunks and a short one: the CAR holds the
    // repeated leaf once.
    dir.write("a.bin", &pattern(3 * 262144 + 9));
    let run = dir.run("a.bin --unixfs --full-car pin.car");
    assert_eq!(run.stdout, "bafyreiexuwateonm5fvddb2prfkaxwsspjeiy7iv6g47a5kua6emeroanm\n");
    let summary = "proofs: a.bin.proofs/ (1 leaves, 2 files, descriptor 158 bytes)\nmap: bafkr4idtm4s6wfblqa5api7thgb5tckqgghbww77ozy3j4jji3zows7sku\n";
    assert_eq!(run.stderr, format!("{summary}unixfs: bafybeifyanohbgoxgjwjoxhib6rhz2u4juqk7mt6kxhrr7kj4jqxardzfy\n"));
    assert_eq!(sha256_hex(&dir, "pin.car"), "dda01e17f6b0599211e00e764e2733bf81c02edea89d8b64277ac6da8c409b7b");
    assert_eq!(
        sha256_hex(&dir, "a.bin.proofs/root"),
        "97a5813239ace96a31874f89540bda527a488c7d15f1b9f075540788c245c06b"
    );
    assert!(!dir.0.join("pin.car.tmp").exists());
    let run = dir.run("a.bin --unixfs --out p2");
    assert_eq!(run.stdout, "bafyreiexuwateonm5fvddb2prfkaxwsspjeiy7iv6g47a5kua6emeroanm\n");
}

#[test]
fn unopenable_full_car_fails_after_the_proofs() {
    let dir = Dir::new("unixfs-missing");
    dir.write("a.bin", &pattern(1000));
    fails(
        &dir.run("a.bin --unixfs --full-car nope/pin.car"),
        "ENOENT: no such file or directory, open 'nope/pin.car.tmp'",
    );
    assert_eq!(dir.files("a.bin.proofs"), ["0", "root"]);
}

#[test]
fn cli_verifies_what_it_packs() {
    let dir = Dir::new("verify-cli");
    dir.write("a.bin", &pattern(5000));
    for (flags, out) in [("--chunk 1", "p1"), ("--chunk 7 --unixfs", "p2"), ("", "p3")] {
        let packed = dir.run(&format!("a.bin --out {out} {flags}"));
        assert_eq!(packed.status, 0, "{}", packed.stderr);
        let run = dir.run(&format!("verify --cid {} --file a.bin --proofs {out}", packed.stdout.trim()));
        assert_eq!((run.status, run.stdout.as_str(), run.stderr.as_str()), (0, "verify OK\n", ""));
    }
    let packed = dir.run("a.bin --out p4 --chunk 1");
    dir.write("b.bin", &pattern(5001));
    let run = dir.run(&format!("verify --cid {} --file b.bin --proofs p4", packed.stdout.trim()));
    fails(&run, "file is 5001 bytes, descriptor says 5000");
    fails(&dir.run("verify --cid nope --file a.bin --proofs p4"), "anchor: CID is not multibase base32");
}

#[test]
fn outputs_over_the_input_are_refused() {
    let dir = Dir::new("refuse");
    dir.write("a.bin", &pattern(100));
    dir.mkdir("sub");
    dir.write("sub/b.bin", &pattern(100));
    dir.write("pin.car.tmp", &pattern(100));
    fails(&dir.run("a.bin --out ."), "--out contains the input file");
    fails(&dir.run("sub/b.bin --out ./sub/"), "--out contains the input file");
    fails(&dir.run("a.bin --out . --unixfs --full-car a.bin"), "--out contains the input file");
    fails(&dir.run("pin.car.tmp --unixfs --full-car ./pin.car"), "--full-car resolves to the input file");
    assert_eq!(dir.run("a.bin --out a.bi").status, 0);
    assert_eq!(dir.run("sub/b.bin --out sub2").status, 0);
}

#[test]
fn output_paths_and_dirs_read_like_node() {
    let dir = Dir::new("outpaths");
    dir.write("in", b"x\n");
    dir.write("f", b"");
    std::os::unix::fs::symlink("loop", dir.0.join("loop")).unwrap();
    dir.mkdir("q/root");
    fails(&dir.run("in --out f/"), "ENOTDIR: not a directory, mkdir 'f/'");
    fails(&dir.run("in --out loop"), "ELOOP: too many symbolic links encountered, mkdir 'loop'");
    fails(&dir.run("in --out q/"), "EISDIR: illegal operation on a directory, open 'q//root'");
    let long = "a".repeat(256);
    fails(&dir.run(&long), &format!("ENAMETOOLONG: name too long, open '{long}'"));
    let run = dir.run("in --out new/.");
    assert_eq!(run.status, 0, "{}", run.stderr);
    assert!(run.stderr.starts_with("proofs: new/./ (1 leaves, 2 files"), "{}", run.stderr);
    assert_eq!(dir.files("new"), ["0", "root"]);
}

#[test]
fn zero_size_pseudo_files_are_read() {
    let dir = Dir::new("procfs");
    let run = dir.run("/proc/self/stat --out p");
    assert_eq!(run.status, 0, "{}", run.stderr);
    assert_eq!(dir.files("p"), ["0", "root"]);
}

#[test]
fn a_failed_pack_leaves_no_car_tmp() {
    let dir = Dir::new("car-tmp");
    dir.write("in", &pattern(300_000));
    dir.mkdir("p/0");
    fails(&dir.run("in --unixfs --full-car c.car --out p"), "EISDIR: illegal operation on a directory, open 'p/0'");
    assert!(!dir.0.join("c.car.tmp").exists());
}

#[test]
fn outputs_that_are_the_input_file_are_refused() {
    let dir = Dir::new("alias");
    let input = pattern(300_000);
    dir.write("in", &input);
    dir.write("x.tmp", &input);
    fs::hard_link(dir.0.join("in"), dir.0.join("c.car.tmp")).unwrap();
    std::os::unix::fs::symlink(".", dir.0.join("l")).unwrap();
    dir.mkdir("p");
    fs::hard_link(dir.0.join("in"), dir.0.join("p/0")).unwrap();
    dir.mkdir("q");
    std::os::unix::fs::symlink("../in", dir.0.join("q/root")).unwrap();
    fails(&dir.run("in --unixfs --full-car c.car --out o1"), "--full-car resolves to the input file");
    fails(&dir.run("x.tmp --unixfs --full-car l/x --out o2"), "--full-car resolves to the input file");
    fails(&dir.run("in --unixfs --full-car c2.car --out p"), "--out contains the input file");
    fails(&dir.run("in --out q"), "--out contains the input file");
    assert_eq!(dir.read("in"), input);
    assert_eq!(dir.read("x.tmp"), input);
    assert!(!dir.0.join("c2.car.tmp").exists());
}
