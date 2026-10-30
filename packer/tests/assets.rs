// `pack assets`: the bundle CAR, its walk order, inline budget, and errors.
// The byte-for-byte comparison with tools/pack.ts is test/pack-diff.test.ts.
mod common;

use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use common::run::{Dir, fails};
use common::sha256;
use veritiles_pack::codec::cid::{DAG_CBOR, RAW, cid_bytes, to_text};

const NOTE_TAIL: &str = "the CAR carries the manifest only and content is fetched from the content URL";

// (cid, block) per section, after the header.
fn sections(car: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut pos = 0;
    let varint = |pos: &mut usize| {
        let (mut value, mut shift) = (0usize, 0);
        loop {
            let byte = car[*pos];
            *pos += 1;
            value |= ((byte & 0x7f) as usize) << shift;
            if byte < 0x80 {
                return value;
            }
            shift += 7;
        }
    };
    let header = varint(&mut pos);
    pos += header;
    let mut out = Vec::new();
    while pos < car.len() {
        let length = varint(&mut pos);
        out.push((car[pos..pos + 36].to_vec(), car[pos + 36..pos + length].to_vec()));
        pos += length;
    }
    out
}

fn raw_cid(bytes: &[u8]) -> Vec<u8> {
    cid_bytes(RAW, &sha256(bytes)).to_vec()
}

#[test]
fn reproduces_the_committed_fonts_bundle() {
    let examples = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/veritiles/examples/assets");
    let dir = Dir::new("assets-fonts");
    let run =
        dir.run_args(["assets".as_ref(), examples.join("fonts").as_os_str(), "--out".as_ref(), "fonts.car".as_ref()]);
    assert_eq!(run.status, 0, "{}", run.stderr);
    assert_eq!(dir.read("fonts.car"), std::fs::read(examples.join("fonts.car")).unwrap());
    let manifest = &sections(&dir.read("fonts.car"))[0].1;
    assert_eq!(run.stdout, format!("{}\n", to_text(&cid_bytes(DAG_CBOR, &sha256(manifest)))));
}

#[test]
fn inlines_unique_blocks_in_walk_order() {
    let dir = Dir::new("assets-order");
    for (name, body) in [("b", "1"), ("a.txt", "2"), ("a", "3"), ("\u{1F600}", "4"), ("\u{E000}", "5"), ("Z", "6")] {
        dir.mkdir("d");
        dir.write(&format!("d/{name}"), body.as_bytes());
    }
    dir.mkdir("d/a.dir");
    dir.write("d/a.dir/x", b"7");
    dir.write("d/dup", b"1");
    dir.write("d/empty", b"");
    std::os::unix::fs::symlink("b", dir.0.join("d/link")).unwrap();
    std::os::unix::fs::symlink("a.dir", dir.0.join("d/linkdir")).unwrap();
    let run = dir.run("assets d");
    assert_eq!(run.status, 0, "{}", run.stderr);
    let blocks = sections(&dir.read("bundle.car"));
    // UTF-16 order puts the astral U+1F600 (a surrogate pair, D83D DE00)
    // before U+E000, where UTF-8 byte order would not.
    let walk = ["6", "3", "7", "2", "1", "", "4", "5"];
    let cids: Vec<Vec<u8>> = blocks[1..].iter().map(|(cid, _)| cid.clone()).collect();
    assert_eq!(cids, walk.iter().map(|body| raw_cid(body.as_bytes())).collect::<Vec<_>>());
}

#[test]
fn types_come_from_the_file_name() {
    let dir = Dir::new("assets-types");
    dir.mkdir("d/v2.json");
    dir.write("d/v2.json/LICENSE", b"MIT");
    dir.write("d/x.PNG", b"p");
    dir.write("d/y.txt", b"t");
    dir.write("d/z", b"z");
    let run = dir.run("assets d --type .TXT=text/plain,=x/none --type .=x/none,TXT=text/plain");
    assert_eq!(run.status, 0, "{}", run.stderr);
    let manifest = String::from_utf8_lossy(&sections(&dir.read("bundle.car"))[0].1).into_owned();
    assert!(manifest.contains("image/png") && manifest.contains("text/plain"));
    // The last --type wins: "" maps the extensionless names.
    assert_eq!(manifest.matches("x/none").count(), 2);
}

#[test]
fn budget_counts_unique_bytes() {
    let dir = Dir::new("assets-budget");
    dir.mkdir("at");
    dir.write("at/a", &vec![1; 131072]);
    dir.write("at/b", &vec![2; 131072]);
    dir.write("at/c", &vec![1; 131072]);
    let run = dir.run("assets at --out at.car");
    assert_eq!((run.status, run.stderr.as_str()), (0, ""));
    assert_eq!(sections(&dir.read("at.car")).len(), 3);
    dir.mkdir("over");
    dir.write("over/a", &vec![1; 131072]);
    dir.write("over/b", &vec![2; 131073]);
    let run = dir.run("assets over --out over.car");
    assert_eq!(run.status, 0);
    assert_eq!(run.stderr, format!("assets: 262145 B exceeds the 262144 B inline budget; {NOTE_TAIL}\n"));
    assert_eq!(sections(&dir.read("over.car")).len(), 1);
}

#[test]
fn walk_errors_read_like_node() {
    let dir = Dir::new("assets-errors");
    dir.mkdir("empty/sub");
    dir.write("file", b"x");
    fails(&dir.run("assets empty"), "manifest must contain at least one resource");
    fails(&dir.run("assets nope/"), "ENOENT: no such file or directory, scandir 'nope/'");
    fails(&dir.run("assets ./x/../nope//"), "ENOENT: no such file or directory, scandir 'nope/'");
    fails(&dir.run("assets file"), "ENOTDIR: not a directory, scandir 'file'");
    fails(&dir.run("assets empty --type png"), "bad --type png");
    dir.write("empty/sub/a", b"a");
    fails(&dir.run("assets empty --out no/b.car"), "ENOENT: no such file or directory, open 'no/b.car'");
}

#[test]
fn rejects_names_that_are_not_utf8() {
    let dir = Dir::new("assets-utf8");
    dir.mkdir("d/sub");
    dir.write("d/a", b"a");
    // Node lists names in byte order, so the first bad name by bytes is the
    // one reported, whatever order the file system returns.
    for bad in [&b"z\xff"[..], b"bad\xc3(", b"zz\xfe"] {
        std::fs::write(dir.0.join("d/sub").join(std::ffi::OsStr::from_bytes(bad)), b"x").unwrap();
    }
    fails(&dir.run("assets d"), "asset name is not valid UTF-8: sub/bad\u{FFFD}(");
}

#[test]
fn rejects_paths_the_manifest_cannot_hold() {
    let dir = Dir::new("assets-deep");
    let deep = vec!["d"; 33].join("/");
    dir.mkdir(&format!("t/{deep}"));
    dir.write(&format!("t/{deep}/f"), b"f");
    fails(&dir.run("assets t"), "path: too many segments");
}

#[test]
fn files_over_2_gib_fail_like_node_read_file() {
    let dir = Dir::new("assets-big");
    dir.mkdir("d");
    // Sparse: no disk space used.
    std::fs::File::create(dir.0.join("d/big.bin")).unwrap().set_len(1 << 31).unwrap();
    fails(&dir.run("assets d"), "File size (2147483648) is greater than 2 GiB");
    assert!(!dir.0.join("bundle.car").exists());
}
