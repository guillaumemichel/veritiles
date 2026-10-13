// The release binary under test, run in a fresh working directory.
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_veritiles-pack");

pub struct Run {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

// A fresh working directory per test, removed on drop.
pub struct Dir(pub PathBuf);

impl Dir {
    pub fn new(name: &str) -> Dir {
        let dir = std::env::temp_dir().join(format!("veritiles-pack-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }

    pub fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.0.join(name), bytes).unwrap();
    }

    pub fn run(&self, args: &str) -> Run {
        self.run_args(args.split(' ').filter(|a| !a.is_empty()))
    }

    pub fn run_args<S: AsRef<OsStr>>(&self, args: impl IntoIterator<Item = S>) -> Run {
        let out = Command::new(BIN).args(args).current_dir(&self.0).output().unwrap();
        Run {
            status: out.status.code().unwrap(),
            stdout: String::from_utf8(out.stdout).unwrap(),
            stderr: String::from_utf8(out.stderr).unwrap(),
        }
    }

    pub fn mkdir(&self, name: &str) {
        fs::create_dir_all(self.0.join(name)).unwrap();
    }

    pub fn read(&self, name: &str) -> Vec<u8> {
        fs::read(self.0.join(name)).unwrap()
    }

    pub fn files(&self, sub: &str) -> Vec<String> {
        let mut files = Vec::new();
        collect(&self.0.join(sub), "", &mut files);
        files.sort();
        files
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn collect(dir: &Path, prefix: &str, files: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        if entry.file_type().unwrap().is_dir() {
            collect(&entry.path(), &format!("{name}/"), files);
        } else {
            files.push(name);
        }
    }
}

pub fn fails(run: &Run, message: &str) {
    assert_eq!((run.status, run.stdout.as_str(), run.stderr.as_str()), (1, "", format!("{message}\n").as_str()));
}
