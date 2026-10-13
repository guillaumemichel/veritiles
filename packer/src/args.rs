// The CLI surface of tools/pack.ts, flag for flag: strict flags, last value
// wins, positionals and flags in any order. Checks run in the TS order.
use crate::codec::MAX_SAFE_INTEGER;
use crate::error::Result;

pub const PACK_USAGE: &str = "usage: pack <input> [--profile auto|fixed|pmtiles|mp4] [--chunk N] [--tile-group N] [--unixfs] [--full-car pin.car] [--out dir]";
pub const ASSETS_USAGE: &str = "usage: pack assets <dir> [--out bundle.car] [--type ext=mime]";
pub const VERIFY_USAGE: &str = "usage: pack verify --cid <anchor> --file <path> --proofs <dir>";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Pack(PackArgs),
    Assets(AssetsArgs),
    Verify(VerifyArgs),
}

#[derive(Debug, PartialEq, Eq)]
pub struct PackArgs {
    pub input: String,
    pub profile: Option<String>,
    pub chunk: Option<u64>,
    pub tile_group: Option<u64>,
    pub unixfs: bool,
    pub full_car: Option<String>,
    pub out: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AssetsArgs {
    pub dir: String,
    pub out: String,
    /// `(extension, mime)` overrides, in flag order; later entries win.
    pub types: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifyArgs {
    pub cid: String,
    pub file: String,
    pub proofs: String,
}

pub fn parse(argv: &[String]) -> Result<Command> {
    match argv.first().map(String::as_str) {
        Some("verify") => parse_verify(&argv[1..]).map(Command::Verify),
        Some("assets") => parse_assets(&argv[1..]).map(Command::Assets),
        _ => parse_pack(argv).map(Command::Pack),
    }
}

fn parse_pack(args: &[String]) -> Result<PackArgs> {
    let flags = Flags::parse(args, &["profile", "chunk", "tile-group", "out", "full-car"], &["unixfs"], 1)?;
    let input = flags.positionals.first().ok_or(PACK_USAGE)?.clone();
    let unixfs = flags.get("unixfs").is_some();
    if flags.get("full-car").is_some() && !unixfs {
        return Err("--full-car requires --unixfs".into());
    }
    let chunk = flags.get("chunk").map(|text| parse_size(text, "--chunk")).transpose()?;
    let tile_group = flags.get("tile-group").map(|text| parse_size(text, "--tile-group")).transpose()?;
    Ok(PackArgs {
        out: flags.get("out").map_or_else(|| format!("{input}.proofs"), str::to_string),
        input,
        profile: flags.get("profile").map(str::to_string),
        chunk,
        tile_group,
        unixfs,
        full_car: flags.get("full-car").map(str::to_string),
    })
}

fn parse_assets(args: &[String]) -> Result<AssetsArgs> {
    let flags = Flags::parse(args, &["out", "type"], &[], 1)?;
    let dir = flags.positionals.first().ok_or(ASSETS_USAGE)?.clone();
    let types = flags.get("type").map_or(Ok(Vec::new()), parse_types)?;
    let out = flags.get("out").unwrap_or("bundle.car").to_string();
    Ok(AssetsArgs { dir, out, types })
}

fn parse_types(list: &str) -> Result<Vec<(String, String)>> {
    let parse_one = |value: &str| match value.find('=') {
        Some(eq) if eq > 0 && eq < value.len() - 1 => {
            let extension = value[..eq].strip_prefix('.').unwrap_or(&value[..eq]);
            Ok((extension.to_lowercase(), value[eq + 1..].to_string()))
        }
        _ => Err(format!("bad --type {value}").into()),
    };
    list.split(',').map(parse_one).collect()
}

fn parse_verify(args: &[String]) -> Result<VerifyArgs> {
    let flags = Flags::parse(args, &["cid", "file", "proofs"], &[], 0)?;
    let get = |name| flags.get(name).map(str::to_string).ok_or(VERIFY_USAGE);
    Ok(VerifyArgs { cid: get("cid")?, file: get("file")?, proofs: get("proofs")? })
}

/// "1MiB" / "256KiB" / "262144" → bytes; the TS regex and safe-integer rule.
pub fn parse_size(text: &str, flag: &str) -> Result<u64> {
    let bad = || format!("bad {flag} value: {text}").into();
    let trimmed = text.trim_matches(is_js_space);
    let digits_end = trimmed.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(trimmed.len());
    let (digits, suffix) = trimmed.split_at(digits_end);
    let unit: u128 = match suffix {
        "" => 1,
        "KiB" | "K" => 1024,
        "MiB" | "M" => 1 << 20,
        _ => return Err(bad()),
    };
    let value = digits.parse::<u128>().ok().and_then(|n| n.checked_mul(unit));
    match value {
        Some(bytes) if bytes <= u128::from(MAX_SAFE_INTEGER) => Ok(bytes as u64),
        _ => Err(bad()),
    }
}

// JS String.prototype.trim's set: Unicode White_Space minus U+0085, plus BOM.
fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

struct Flags {
    positionals: Vec<String>,
    values: Vec<(&'static str, String)>,
}

impl Flags {
    fn parse(args: &[String], values: &[&'static str], booleans: &[&'static str], positionals: usize) -> Result<Flags> {
        let mut flags = Flags { positionals: Vec::new(), values: Vec::new() };
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            let Some(name) = arg.strip_prefix("--") else {
                if flags.positionals.len() == positionals {
                    return Err(format!("unexpected argument {arg}").into());
                }
                flags.positionals.push(arg.clone());
                continue;
            };
            if let Some(&known) = booleans.iter().find(|&&b| b == name) {
                flags.values.push((known, "true".into()));
                continue;
            }
            let known = *values.iter().find(|&&v| v == name).ok_or_else(|| format!("unknown flag {arg}"))?;
            match rest.next() {
                Some(value) if !value.is_empty() && !value.starts_with("--") => {
                    flags.values.push((known, value.clone()))
                }
                _ => return Err(format!("{arg} requires a value").into()),
            }
        }
        Ok(flags)
    }

    // Last value wins.
    fn get(&self, name: &str) -> Option<&str> {
        self.values.iter().rev().find(|(n, _)| *n == name).map(|(_, v)| v.as_str())
    }
}
