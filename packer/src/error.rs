// One error type for the whole tool: the CLI prints its message and exits 1,
// matching tools/pack.ts, so the message text is the whole contract.
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error(message.to_string())
    }
}

/// Node's fs error text (`ENOENT: no such file or directory, open 'x'`), so
/// I/O failures read the same as from tools/pack.ts.
pub fn io_error(err: &std::io::Error, syscall: &str, path: &str) -> Error {
    Error(format!("{}, {syscall} '{path}'", describe(err)))
}

/// Node's text for a failed syscall that names no path (`EIO: i/o error, read`).
pub fn io_error_bare(err: &std::io::Error, syscall: &str) -> Error {
    Error(format!("{}, {syscall}", describe(err)))
}

fn describe(err: &std::io::Error) -> String {
    match err.raw_os_error().and_then(errno_text) {
        Some((code, text)) => format!("{code}: {text}"),
        None => err.to_string(),
    }
}

fn errno_text(errno: i32) -> Option<(&'static str, &'static str)> {
    Some(match errno {
        // libuv's wording (uv_strerror), as Node prints it.
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        5 => ("EIO", "i/o error"),
        6 => ("ENXIO", "no such device or address"),
        13 => ("EACCES", "permission denied"),
        16 => ("EBUSY", "resource busy or locked"),
        17 => ("EEXIST", "file already exists"),
        18 => ("EXDEV", "cross-device link not permitted"),
        19 => ("ENODEV", "no such device"),
        20 => ("ENOTDIR", "not a directory"),
        21 => ("EISDIR", "illegal operation on a directory"),
        22 => ("EINVAL", "invalid argument"),
        23 => ("ENFILE", "file table overflow"),
        24 => ("EMFILE", "too many open files"),
        26 => ("ETXTBSY", "text file is busy"),
        27 => ("EFBIG", "file too large"),
        28 => ("ENOSPC", "no space left on device"),
        30 => ("EROFS", "read-only file system"),
        36 => ("ENAMETOOLONG", "name too long"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_read_like_node() {
        let err = std::io::Error::from_raw_os_error(2);
        assert_eq!(io_error(&err, "open", "x").0, "ENOENT: no such file or directory, open 'x'");
        let long = std::io::Error::from_raw_os_error(36);
        assert_eq!(io_error(&long, "open", "x").0, "ENAMETOOLONG: name too long, open 'x'");
        let looped = std::io::Error::from_raw_os_error(40);
        assert_eq!(io_error(&looped, "open", "x").0, "ELOOP: too many symbolic links encountered, open 'x'");
        let busy = std::io::Error::from_raw_os_error(16);
        assert_eq!(io_error_bare(&busy, "read").0, "EBUSY: resource busy or locked, read");
        let other = std::io::Error::from_raw_os_error(122);
        assert!(io_error(&other, "open", "x").0.ends_with(", open 'x'"));
    }
}
