// Node fs and path semantics the outputs and error messages depend on:
// recursive mkdir (node_file.cc MKDirp), readFile's size limit, and posix
// `path.dirname`, `path.join` and `path.resolve`. tools/pack.ts uses these,
// so Rust copies them rather than std's.
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};

use crate::error::{Result, io_error, io_error_bare};

// readFile's limit (kIoMaxLength): 2 GiB − 1.
const READ_FILE_MAX: u64 = (1 << 31) - 1;

/// `mkdir(path, { recursive: true })` as fs/promises runs it; an error
/// names the path of the step that failed, as Node does.
pub fn mkdirp(path: &str) -> Result<()> {
    mkdirp_io(path).map_err(|(e, at)| io_error(&e, "mkdir", &at))
}

// MKDirpAsync: try the path; on ENOENT make its parent (cut at the last
// '/', no normalisation) and retry; on any other error the path is fine
// only if stat finds a directory there.
fn mkdirp_io(path: &str) -> std::result::Result<(), (io::Error, String)> {
    let mut stack = vec![path.to_string()];
    // Node retries a path forever when its parent exists but mkdir still
    // says ENOENT (/proc); Rust reports the ENOENT the second time.
    let mut retried = HashSet::new();
    while let Some(next) = stack.pop() {
        let Err(err) = fs::create_dir(&next) else { continue };
        let errno = err.raw_os_error().unwrap_or(0);
        if [libc::EACCES, libc::ENOSPC, libc::ENOTDIR, libc::EPERM].contains(&errno) {
            return Err((err, next));
        }
        if errno == libc::ENOENT {
            match next.rfind('/').map(|slash| next[..slash].to_string()) {
                Some(parent) if retried.insert(next.clone()) => stack.extend([next, parent]),
                Some(_) => return Err((err, next)),
                None if stack.is_empty() => check_existing(&next, libc::EEXIST, false).map_err(|e| (e, next))?,
                None => {}
            }
            continue;
        }
        let deeper = !stack.is_empty();
        check_existing(&next, errno, deeper).map_err(|e| (e, next))?;
    }
    Ok(())
}

// After a failed mkdir: a directory is success. An EEXIST with a deeper
// path pending is otherwise ENOTDIR, even when stat fails (a dangling
// symlink); else stat's error is the error, and a non-directory EEXIST.
fn check_existing(path: &str, errno: i32, deeper: bool) -> io::Result<()> {
    let stat = fs::metadata(path);
    if stat.as_ref().is_ok_and(|meta| meta.is_dir()) {
        return Ok(());
    }
    if errno == libc::EEXIST && deeper {
        return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
    }
    stat?;
    Err(io::Error::from_raw_os_error(libc::EEXIST))
}

/// Node's posix `path.dirname`.
pub fn dirname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let rooted = bytes.first() == Some(&b'/');
    let mut seen_name = false;
    for i in (1..bytes.len()).rev() {
        if bytes[i] != b'/' {
            seen_name = true;
            continue;
        }
        if seen_name {
            return if rooted && i == 1 { "//" } else { &path[..i] };
        }
    }
    match (path.is_empty(), rooted) {
        (false, true) => "/",
        _ => ".",
    }
}

/// `readFile(path)`: a regular file over 2 GiB − 1 is refused before
/// reading; other files are read to EOF.
pub fn read_file(path: &str) -> Result<Vec<u8>> {
    let mut file = File::open(path).map_err(|e| io_error(&e, "open", path))?;
    let meta = file.metadata().map_err(|e| io_error_bare(&e, "fstat"))?;
    if meta.is_file() && meta.len() > READ_FILE_MAX {
        return Err(format!("File size ({}) is greater than 2 GiB", meta.len()).into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| io_error_bare(&e, "read"))?;
    Ok(bytes)
}

/// `path.join(dir, relative)`: lexically normalised, a trailing slash kept.
pub fn join(dir: &str, relative: &str) -> String {
    let joined = match (dir.is_empty(), relative.is_empty()) {
        (_, true) => dir.to_string(),
        (true, false) => relative.to_string(),
        (false, false) => format!("{dir}/{relative}"),
    };
    normalize(&joined)
}

/// `path.resolve(path)`: absolute and lexically normalised, symlinks
/// untouched, no trailing slash. Only a relative path reads the cwd.
pub fn resolve(path: &str) -> Result<String> {
    let absolute = if path.starts_with('/') {
        path.to_string()
    } else {
        let cwd = std::env::current_dir().map_err(|e| io_error_bare(&e, "uv_cwd"))?;
        format!("{}/{path}", cwd.to_string_lossy())
    };
    let resolved = normalize(&absolute);
    Ok(match resolved.strip_suffix('/') {
        Some(trimmed) if !trimmed.is_empty() => trimmed.to_string(),
        _ => resolved,
    })
}

fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            _ => parts.push(segment),
        }
    }
    let body = parts.join("/");
    let trailing = if path.ends_with('/') && !(body.is_empty() && absolute) { "/" } else { "" };
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}{trailing}"),
        (false, true) => format!(".{trailing}"),
        (false, false) => format!("{body}{trailing}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirname_like_node() {
        let cases = [
            ("q//0", "q/"),
            ("q/./0", "q/."),
            ("/0", "/"),
            ("a/b/", "a"),
            ("x", "."),
            ("", "."),
            ("/", "/"),
            ("//a", "//"),
            ("a//", "."),
        ];
        for (path, dir) in cases {
            assert_eq!(dirname(path), dir, "{path}");
        }
    }

    #[test]
    fn join_like_node() {
        let cases = [
            ("d", "", "d"),
            ("d/", "", "d/"),
            ("./d/", "a/b", "d/a/b"),
            ("nope//x/..", "", "nope"),
            ("a/../../nope", "", "../nope"),
            ("/tmp/../nope", "", "/nope"),
            ("/", "", "/"),
            ("/..", "", "/"),
            (".", "", "."),
            ("./", "", "./"),
            ("", "", "."),
            ("x/..", "a", "a"),
            ("../..", "", "../.."),
        ];
        for (dir, relative, joined) in cases {
            assert_eq!(join(dir, relative), joined, "{dir} + {relative}");
        }
    }

    #[test]
    fn resolve_like_node() {
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let parent = cwd.rsplit_once('/').unwrap().0;
        let cases = [("/", "/"), ("//a/./b/", "/a/b"), ("/a/../../b", "/b"), ("/a//", "/a")];
        for (path, resolved) in cases {
            assert_eq!(resolve(path).unwrap(), resolved, "{path}");
        }
        assert_eq!(resolve("x/").unwrap(), format!("{cwd}/x"));
        assert_eq!(resolve("").unwrap(), cwd);
        assert_eq!(resolve("..").unwrap(), if parent.is_empty() { "/" } else { parent });
    }

    fn scratch(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("veritiles-nodefs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn mkdirp_like_node() {
        let d = scratch("mkdirp");
        fs::write(format!("{d}/f"), b"").unwrap();
        std::os::unix::fs::symlink("loop", format!("{d}/loop")).unwrap();
        let error = |p: &str| mkdirp(&format!("{d}/{p}")).unwrap_err().0.replace(&d, "<d>");
        assert_eq!(error("f/"), "ENOTDIR: not a directory, mkdir '<d>/f/'");
        assert_eq!(error("f"), "EEXIST: file already exists, mkdir '<d>/f'");
        assert_eq!(error("f/x/y"), "ENOTDIR: not a directory, mkdir '<d>/f/x/y'");
        assert_eq!(error("loop"), "ELOOP: too many symbolic links encountered, mkdir '<d>/loop'");
        assert_eq!(error("loop/x"), "ELOOP: too many symbolic links encountered, mkdir '<d>/loop/x'");
        for ok in ["new/.", "a/./b/../c", "x//y/", "z/..", "a/b"] {
            mkdirp(&format!("{d}/{ok}")).unwrap();
        }
        for dir in ["new", "a/b", "a/c", "x/y", "z"] {
            assert!(fs::metadata(format!("{d}/{dir}")).unwrap().is_dir(), "{dir}");
        }
        fs::remove_dir_all(&d).unwrap();
    }

    // Probed on Node 22.23 (fs/promises mkdir, recursive): a failure names
    // the path of the step that failed, and an existing non-directory parent
    // with a deeper path pending is ENOTDIR, even when stat fails on it.
    #[test]
    fn mkdirp_names_the_failing_step_like_node() {
        let d = scratch("mkdirp-step");
        fs::write(format!("{d}/f"), b"").unwrap();
        fs::create_dir(format!("{d}/e")).unwrap();
        fs::create_dir(format!("{d}/ro")).unwrap();
        fs::set_permissions(format!("{d}/ro"), std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
        std::os::unix::fs::symlink("nowhere", format!("{d}/ld")).unwrap();
        std::os::unix::fs::symlink("ld", format!("{d}/ld2")).unwrap();
        std::os::unix::fs::symlink("f", format!("{d}/lf")).unwrap();
        let error = |p: &str| mkdirp(&format!("{d}/{p}")).unwrap_err().0.replace(&d, "<d>");
        let cases = [
            ("ld", "ENOENT: no such file or directory, mkdir '<d>/ld'"),
            ("ld/", "ENOENT: no such file or directory, mkdir '<d>/ld/'"),
            ("ld/x", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld/x/y", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld//x", "ENOTDIR: not a directory, mkdir '<d>/ld/'"),
            ("ld/./x", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld/x/", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld/.", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld/..", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("ld/../x", "ENOTDIR: not a directory, mkdir '<d>/ld'"),
            ("e/../ld", "ENOENT: no such file or directory, mkdir '<d>/e/../ld'"),
            ("e/../ld/x", "ENOTDIR: not a directory, mkdir '<d>/e/../ld'"),
            ("e/x/../../ld/y", "ENOTDIR: not a directory, mkdir '<d>/e/x/../../ld'"),
            ("ld2/x", "ENOTDIR: not a directory, mkdir '<d>/ld2'"),
            ("lf", "EEXIST: file already exists, mkdir '<d>/lf'"),
            ("lf/", "ENOTDIR: not a directory, mkdir '<d>/lf/'"),
            ("lf/x/y", "ENOTDIR: not a directory, mkdir '<d>/lf/x/y'"),
            ("lf/../x", "ENOTDIR: not a directory, mkdir '<d>/lf/../x'"),
            ("e/../f/x", "ENOTDIR: not a directory, mkdir '<d>/e/../f/x'"),
            ("f//x", "ENOTDIR: not a directory, mkdir '<d>/f//x'"),
        ];
        for (path, message) in cases {
            assert_eq!(error(path), message, "{path}");
        }
        // Root ignores the mode bits.
        if fs::create_dir(format!("{d}/ro/root")).is_err() {
            assert_eq!(error("ro/a/b/c"), "EACCES: permission denied, mkdir '<d>/ro/a'");
        }
        fs::set_permissions(format!("{d}/ro"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn mkdirp_reports_a_repeated_enoent() {
        let error = mkdirp("/proc/veritiles-x").unwrap_err().0;
        assert_eq!(error, "ENOENT: no such file or directory, mkdir '/proc/veritiles-x'");
    }

    #[test]
    fn read_file_like_node() {
        let d = scratch("read");
        let big = format!("{d}/big");
        File::create(&big).unwrap().set_len(1 << 31).unwrap();
        assert_eq!(read_file(&big).unwrap_err().0, "File size (2147483648) is greater than 2 GiB");
        assert_eq!(read_file(&d).unwrap_err().0, "EISDIR: illegal operation on a directory, read");
        let missing = format!("{d}/missing");
        assert_eq!(read_file(&missing).unwrap_err().0, format!("ENOENT: no such file or directory, open '{missing}'"));
        assert!(!read_file("/proc/version").unwrap().is_empty());
        fs::remove_dir_all(&d).unwrap();
    }
}
