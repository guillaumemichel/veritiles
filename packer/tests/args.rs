use anymirror_pack::args::{
    ASSETS_USAGE, AssetsArgs, Command, PACK_USAGE, PackArgs, VERIFY_USAGE, VerifyArgs, parse, parse_size,
};

fn argv(text: &str) -> Vec<String> {
    text.split(' ').filter(|s| !s.is_empty()).map(String::from).collect()
}

fn err(text: &str) -> String {
    parse(&argv(text)).unwrap_err().0
}

fn pack(text: &str) -> PackArgs {
    match parse(&argv(text)).unwrap() {
        Command::Pack(args) => args,
        other => panic!("not pack: {other:?}"),
    }
}

#[test]
fn pack_defaults() {
    let args = pack("map.bin");
    let want = PackArgs {
        input: "map.bin".into(),
        profile: None,
        chunk: None,
        tile_group: None,
        unixfs: false,
        full_car: None,
        out: "map.bin.proofs".into(),
    };
    assert_eq!(args, want);
}

#[test]
fn pack_flags_in_any_order_last_wins() {
    let args = pack("--out a --chunk 1K map.bin --out b --unixfs --full-car x.car --profile fixed --tile-group 2M");
    assert_eq!(args.out, "b");
    assert_eq!(args.chunk, Some(1024));
    assert_eq!(args.tile_group, Some(2 << 20));
    assert!(args.unixfs);
    assert_eq!(args.full_car.as_deref(), Some("x.car"));
    assert_eq!(args.profile.as_deref(), Some("fixed"));
}

#[test]
fn pack_errors_in_ts_order() {
    assert_eq!(err(""), PACK_USAGE);
    assert_eq!(err("--out x"), PACK_USAGE);
    assert_eq!(err("a b"), "unexpected argument b");
    assert_eq!(err("a --bogus"), "unknown flag --bogus");
    assert_eq!(err("a --"), "unknown flag --");
    assert_eq!(err("a --out"), "--out requires a value");
    assert_eq!(err("a --out --unixfs"), "--out requires a value");
    assert_eq!(err("--full-car x a"), "--full-car requires --unixfs");
    assert_eq!(err("--full-car x --chunk bad a"), "--full-car requires --unixfs");
    assert_eq!(err("a --chunk 1G --tile-group bad"), "bad --chunk value: 1G");
    assert_eq!(err("a --tile-group 1x"), "bad --tile-group value: 1x");
    assert_eq!(err("a --bogus b"), "unknown flag --bogus");
}

#[test]
fn empty_value_is_missing() {
    let args = vec!["a".to_string(), "--out".to_string(), String::new()];
    assert_eq!(parse(&args).unwrap_err().0, "--out requires a value");
}

#[test]
fn sizes() {
    assert_eq!(parse_size("262144", "--chunk").unwrap(), 262144);
    assert_eq!(parse_size(" 256KiB\n", "--chunk").unwrap(), 256 << 10);
    assert_eq!(parse_size("\u{feff}1M\u{3000}", "--chunk").unwrap(), 1 << 20);
    assert_eq!(parse_size("0", "--chunk").unwrap(), 0);
    assert_eq!(parse_size("007K", "--chunk").unwrap(), 7 << 10);
    assert_eq!(parse_size("9007199254740991", "--chunk").unwrap(), (1 << 53) - 1);
    for bad in ["9007199254740992", "8796093022208K", "", "K", "1k", "1 K", "-1", "1.5", "1GiB", "\u{85}1", "١"] {
        assert_eq!(parse_size(bad, "--chunk").unwrap_err().0, format!("bad --chunk value: {bad}"), "{bad:?}");
    }
    let huge = "9".repeat(60);
    assert!(parse_size(&huge, "--chunk").is_err());
}

#[test]
fn assets_args() {
    let want = AssetsArgs { dir: "d".into(), out: "bundle.car".into(), types: vec![] };
    assert_eq!(parse(&argv("assets d")).unwrap(), Command::Assets(want));
    let Command::Assets(args) = parse(&argv("assets --type .PBF=a/b,x=y=z d --out o.car")).unwrap() else { panic!() };
    assert_eq!(args.types, vec![("pbf".into(), "a/b".into()), ("x".into(), "y=z".into())]);
    assert_eq!(args.out, "o.car");
    assert_eq!(err("assets"), ASSETS_USAGE);
    assert_eq!(err("assets d e"), "unexpected argument e");
    assert_eq!(err("assets d --unixfs"), "unknown flag --unixfs");
    for bad in ["=x", "x=", "x", "a=b,,c=d"] {
        let value = bad.split(',').find(|v| !v.contains('=') || v.starts_with('=') || v.ends_with('=')).unwrap();
        assert_eq!(err(&format!("assets d --type {bad}")), format!("bad --type {value}"));
    }
}

#[test]
fn verify_args() {
    let want = VerifyArgs { cid: "c".into(), file: "f".into(), proofs: "p".into() };
    assert_eq!(parse(&argv("verify --proofs p --file f --cid c")).unwrap(), Command::Verify(want));
    assert_eq!(err("verify --cid c --file f"), VERIFY_USAGE);
    assert_eq!(err("verify x"), "unexpected argument x");
    assert_eq!(err("verify --reads 3"), "unknown flag --reads");
}
