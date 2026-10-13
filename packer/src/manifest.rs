// The MASL bundle manifest (src/manifest.ts encodeManifest, withType): a
// DRISL map {$type: "ing.dasl.masl", resources: {path: entry}}, resource
// keys sorted by their encoded bytes. Checks and messages copy the TS ones,
// in the same order, so a directory TS rejects fails here identically.
use crate::codec::MAX_SAFE_INTEGER;
use crate::codec::cbor::{encode_uint, map_head, push_cid, text};
use crate::codec::cid::CidBytes;
use crate::error::Result;

const MANIFEST_CAP: usize = 256 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_SEGMENTS: usize = 32;
const MAX_NAME: usize = 255;
const MAX_CBOR_LENGTH: usize = 0xffff;

#[derive(Debug, Clone)]
pub struct Resource {
    /// The manifest key: `/` and the slash-joined relative path.
    pub path: String,
    /// The content's raw CID.
    pub src: CidBytes,
    pub size: u64,
    pub content_type: Option<String>,
}

pub fn encode(mut resources: Vec<Resource>) -> Result<Vec<u8>> {
    if resources.is_empty() {
        return Err("manifest must contain at least one resource".into());
    }
    if resources.len() > MAX_CBOR_LENGTH {
        return Err(format!("bad CBOR length {}", resources.len()).into());
    }
    resources.sort_by_cached_key(|resource| text(&resource.path));
    let mut out = map_head(2);
    out.extend(text("$type"));
    out.extend(text("ing.dasl.masl"));
    out.extend(text("resources"));
    out.extend(map_head(resources.len()));
    let mut previous: Option<&str> = None;
    for resource in &resources {
        check(resource, previous)?;
        previous = Some(&resource.path);
        push_entry(&mut out, resource);
    }
    if out.len() > MANIFEST_CAP {
        return Err("manifest body over cap".into());
    }
    Ok(out)
}

fn check(resource: &Resource, previous: Option<&str>) -> Result<()> {
    validate_path_key(&resource.path)?;
    if previous == Some(resource.path.as_str()) {
        return Err(format!("duplicate manifest path {}", resource.path).into());
    }
    if resource.size > MAX_SAFE_INTEGER {
        return Err("manifest entry size must be a uint < 2^53".into());
    }
    let type_len = resource.content_type.as_ref().map_or(1, String::len);
    if !(1..=MAX_NAME).contains(&type_len) {
        return Err("manifest content-type must be 1..255 bytes".into());
    }
    Ok(())
}

fn push_entry(out: &mut Vec<u8>, resource: &Resource) {
    out.extend(text(&resource.path));
    out.extend(map_head(if resource.content_type.is_some() { 3 } else { 2 }));
    out.extend(text("src"));
    push_cid(out, &resource.src);
    out.extend(text("size"));
    out.extend(encode_uint(resource.size));
    if let Some(content_type) = &resource.content_type {
        out.extend(text("content-type"));
        out.extend(text(content_type));
    }
}

fn validate_path_key(path: &str) -> Result<()> {
    if (path.len() < 2 && path != "/") || path.len() > MAX_PATH_BYTES || !path.starts_with('/') {
        return Err("manifest: invalid resource path".into());
    }
    validate_segments(&path[1..])
}

fn validate_segments(path: &str) -> Result<()> {
    if path.is_empty() {
        return Ok(());
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > MAX_SEGMENTS {
        return Err("path: too many segments".into());
    }
    for segment in segments {
        match segment {
            "" => return Err("path: empty segment".into()),
            "." | ".." => return Err(format!("path: '{segment}' segment").into()),
            _ if segment.contains('\0') => return Err("path: NUL segment".into()),
            _ if segment.len() > MAX_NAME => return Err("path: segment over 255 bytes".into()),
            _ => {}
        }
    }
    Ok(())
}
