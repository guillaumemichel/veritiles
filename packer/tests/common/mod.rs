// Test support: a tiny JSON reader for the fixtures (no serde, by design),
// hex, CID text, hashing and input helpers. Fixtures are trusted, generated
// by tools/gen-rust-vectors.ts.
#![allow(dead_code)]

pub mod run;

use std::path::PathBuf;

use anymirror_pack::codec::Digest;
use anymirror_pack::codec::cid::{CidBytes, to_text};
use sha2::{Digest as _, Sha256};

#[derive(Debug, Clone)]
pub enum Json {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        let Json::Obj(fields) = self else { return None };
        fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn at(&self, key: &str) -> &Json {
        self.get(key).unwrap_or_else(|| panic!("missing key {key}"))
    }
    pub fn str(&self) -> &str {
        let Json::Str(s) = self else { panic!("not a string: {self:?}") };
        s
    }
    pub fn bool(&self) -> bool {
        let Json::Bool(b) = self else { panic!("not a bool: {self:?}") };
        *b
    }
    pub fn u64(&self) -> u64 {
        let Json::Num(n) = self else { panic!("not a number: {self:?}") };
        n.parse().unwrap()
    }
    pub fn arr(&self) -> &[Json] {
        let Json::Arr(items) = self else { panic!("not an array: {self:?}") };
        items
    }
}

pub fn fixture(name: &str) -> Json {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let text = std::fs::read_to_string(path).unwrap();
    let mut parser = Parser { bytes: text.as_bytes(), pos: 0 };
    parser.value()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

pub fn sha256(bytes: &[u8]) -> Digest {
    Sha256::digest(bytes).into()
}

pub fn blake3(bytes: &[u8]) -> Digest {
    *blake3::hash(bytes).as_bytes()
}

/// Deterministic input bytes with a 64 KiB period.
pub fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 7 + (i >> 8)) & 255) as u8).collect()
}

/// A fixture's base32 CID text ('b' prefix) as bytes.
pub fn cid_from_text(text: &str) -> CidBytes {
    const BASE32: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let (mut value, mut bits, mut bytes) = (0u32, 0, Vec::new());
    for ch in text[1..].bytes() {
        value = (value << 5) | BASE32.iter().position(|&c| c == ch).unwrap() as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((value >> bits) as u8);
        }
        value &= (1 << bits) - 1;
    }
    let cid: CidBytes = bytes.try_into().unwrap();
    assert_eq!(to_text(&cid), text, "a canonical CID");
    cid
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn value(&mut self) -> Json {
        self.skip_ws();
        match self.bytes[self.pos] {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Json::Str(self.string()),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'n' => self.word("null", Json::Null),
            _ => self.number(),
        }
    }

    fn object(&mut self) -> Json {
        let mut fields = Vec::new();
        self.pos += 1;
        loop {
            self.skip_ws();
            if self.bytes[self.pos] == b'}' {
                self.pos += 1;
                return Json::Obj(fields);
            }
            if self.bytes[self.pos] == b',' {
                self.pos += 1;
                self.skip_ws();
            }
            let key = self.string();
            self.skip_ws();
            self.pos += 1; // ':'
            fields.push((key, self.value()));
        }
    }

    fn array(&mut self) -> Json {
        let mut items = Vec::new();
        self.pos += 1;
        loop {
            self.skip_ws();
            match self.bytes[self.pos] {
                b']' => {
                    self.pos += 1;
                    return Json::Arr(items);
                }
                b',' => self.pos += 1,
                _ => items.push(self.value()),
            }
        }
    }

    // Fixture strings are UTF-8 with JSON.stringify's escapes: \" \\ and
    // \uXXXX (surrogate pairs included).
    fn string(&mut self) -> String {
        let mut units: Vec<u16> = Vec::new();
        self.pos += 1;
        while self.bytes[self.pos] != b'"' {
            if self.bytes[self.pos] == b'\\' {
                self.pos += 1;
                if self.bytes[self.pos] == b'u' {
                    let hex = std::str::from_utf8(&self.bytes[self.pos + 1..self.pos + 5]).unwrap();
                    units.push(u16::from_str_radix(hex, 16).unwrap());
                    self.pos += 5;
                    continue;
                }
            }
            let width = match self.bytes[self.pos] {
                0..0x80 => 1,
                0x80..0xe0 => 2,
                0xe0..0xf0 => 3,
                _ => 4,
            };
            let ch = std::str::from_utf8(&self.bytes[self.pos..self.pos + width]).unwrap().chars().next().unwrap();
            units.extend(ch.encode_utf16(&mut [0; 2]).iter());
            self.pos += ch.len_utf8();
        }
        self.pos += 1;
        String::from_utf16(&units).unwrap()
    }

    fn number(&mut self) -> Json {
        let start = self.pos;
        while self.pos < self.bytes.len() && b"-+.eE0123456789".contains(&self.bytes[self.pos]) {
            self.pos += 1;
        }
        Json::Num(String::from_utf8(self.bytes[start..self.pos].to_vec()).unwrap())
    }

    fn word(&mut self, word: &str, value: Json) -> Json {
        self.pos += word.len();
        value
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }
}
