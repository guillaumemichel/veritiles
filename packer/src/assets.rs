// `pack assets <dir>` (tools/pack.ts packAssets): a MASL bundle CAR — the
// manifest, then each unique file's raw block when the unique bytes fit the
// inline budget. The walk copies Node's: names decoded before sorting, each
// directory in UTF-16 order, symlinks and other non-regular files skipped,
// and every path built with `path.join` so error messages match.
use std::collections::HashSet;
use std::fs;
use std::os::unix::ffi::OsStrExt;

use sha2::{Digest as _, Sha256};

use crate::args::AssetsArgs;
use crate::car;
use crate::codec::cid::{CidBytes, DAG_CBOR, RAW, cid_bytes, to_text};
use crate::error::{Result, io_error};
use crate::manifest::{self, Resource};
use crate::nodefs;

const INLINE_TOTAL_CAP: u64 = 256 * 1024;
const DEFAULT_TYPES: &[(&str, &str)] = &[
    ("json", "application/json"),
    ("pbf", "application/x-protobuf"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
];

pub struct Bundle {
    pub anchor: String,
    pub car: Vec<u8>,
    /// Unique content bytes; inlined only within the budget.
    pub total: u64,
}

/// Walks `args.dir` and builds the bundle CAR.
pub fn assets(args: &AssetsArgs) -> Result<Bundle> {
    let mut walk = Walk { args, resources: Vec::new(), seen: HashSet::new(), blocks: Vec::new(), total: 0 };
    walk.dir("")?;
    let manifest = manifest::encode(walk.resources)?;
    let root = cid_bytes(DAG_CBOR, &Sha256::digest(&manifest).into());
    let mut car = car::header(&root).to_vec();
    push_section(&mut car, &root, &manifest);
    walk.blocks.iter().for_each(|(cid, bytes)| push_section(&mut car, cid, bytes));
    Ok(Bundle { anchor: to_text(&root), car, total: walk.total })
}

impl Bundle {
    /// The note tools/pack.ts prints when content is not inlined.
    pub fn budget_note(&self) -> Option<String> {
        let note = "the CAR carries the manifest only and content is fetched from the content URL";
        let over = self.total > INLINE_TOTAL_CAP;
        over.then(|| format!("assets: {} B exceeds the {INLINE_TOTAL_CAP} B inline budget; {note}", self.total))
    }

    pub fn write(&self, path: &str) -> Result<()> {
        fs::write(path, &self.car).map_err(|e| io_error(&e, "open", path))
    }
}

fn push_section(out: &mut Vec<u8>, cid: &CidBytes, bytes: &[u8]) {
    out.extend(car::section_head(cid, bytes.len()));
    out.extend_from_slice(bytes);
}

struct Walk<'a> {
    args: &'a AssetsArgs,
    resources: Vec<Resource>,
    seen: HashSet<CidBytes>,
    /// Unique blocks in walk order, kept only while they fit the budget.
    blocks: Vec<(CidBytes, Vec<u8>)>,
    total: u64,
}

enum Kind {
    Dir,
    File,
    Other,
}

impl Walk<'_> {
    fn dir(&mut self, relative: &str) -> Result<()> {
        for (name, kind) in self.listing(relative)? {
            let path = if relative.is_empty() { name } else { format!("{relative}/{name}") };
            match kind {
                Kind::Dir => self.dir(&path)?,
                Kind::File => self.file(path)?,
                Kind::Other => {}
            }
        }
        Ok(())
    }

    // Node lists a directory in strcmp order (libuv's scandir sorts), and TS
    // decodes every name before using any: the first invalid name in byte
    // order is the error. The walk itself then goes in UTF-16 order.
    fn listing(&self, relative: &str) -> Result<Vec<(String, Kind)>> {
        let path = nodefs::join(&self.args.dir, relative);
        let scandir = |e: std::io::Error| io_error(&e, "scandir", &path);
        let mut raw = Vec::new();
        for entry in fs::read_dir(&path).map_err(scandir)? {
            let entry = entry.map_err(scandir)?;
            raw.push((entry.file_name(), kind(entry.file_type().map_err(scandir)?)));
        }
        raw.sort_by(|(a, _), (b, _)| a.as_bytes().cmp(b.as_bytes()));
        let mut items = Vec::with_capacity(raw.len());
        for (name, kind) in raw {
            items.push((utf8_name(name, relative)?, kind));
        }
        items.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(items)
    }

    fn file(&mut self, path: String) -> Result<()> {
        let bytes = nodefs::read_file(&nodefs::join(&self.args.dir, &path))?;
        let src = cid_bytes(RAW, &Sha256::digest(&bytes).into());
        let size = bytes.len() as u64;
        if self.seen.insert(src) {
            self.total += size;
            if self.total <= INLINE_TOTAL_CAP {
                self.blocks.push((src, bytes));
            } else {
                self.blocks.clear();
            }
        }
        let content_type = self.content_type(&path);
        self.resources.push(Resource { path: format!("/{path}"), src, size, content_type });
        Ok(())
    }

    // The extension after the name's last dot, lowercased; --type wins.
    fn content_type(&self, path: &str) -> Option<String> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let extension = name.rfind('.').map_or(String::new(), |dot| name[dot + 1..].to_lowercase());
        let custom = self.args.types.iter().rev().find(|(ext, _)| *ext == extension).map(|(_, mime)| mime.as_str());
        let default = || DEFAULT_TYPES.iter().find(|(ext, _)| *ext == extension).map(|(_, mime)| *mime);
        custom.or_else(default).map(str::to_string)
    }
}

// Dirent semantics: a symlink is neither, whatever it points at.
fn kind(file_type: fs::FileType) -> Kind {
    match (file_type.is_dir(), file_type.is_file()) {
        (true, _) => Kind::Dir,
        (_, true) => Kind::File,
        _ => Kind::Other,
    }
}

fn utf8_name(name: std::ffi::OsString, relative: &str) -> Result<String> {
    name.into_string().map_err(|name| {
        let lossy = String::from_utf8_lossy(name.as_bytes()).into_owned();
        let shown = if relative.is_empty() { lossy } else { format!("{relative}/{lossy}") };
        format!("asset name is not valid UTF-8: {shown}").into()
    })
}
