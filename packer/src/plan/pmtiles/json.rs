// PMTiles metadata must parse as a JSON object, exactly as tools/pack.ts
// decides with TextDecoder + JSON.parse. Checked at the byte level: the
// decoder strips one BOM and turns invalid UTF-8 into U+FFFD without eating
// ASCII bytes, so non-ASCII bytes are fine inside strings and invalid
// elsewhere. JSON.parse has no depth limit and accepts any \u escape and
// out-of-range numbers (1e400), so this validator does too; nesting depth
// lives on a heap stack, not the call stack.
use crate::error::Result;

const NOT_JSON: &str = "PMTiles metadata is not valid JSON";
const NOT_OBJECT: &str = "PMTiles metadata must be a JSON object";
const BOM: &[u8] = b"\xef\xbb\xbf";

pub fn check_metadata(bytes: &[u8]) -> Result<()> {
    let text = bytes.strip_prefix(BOM).unwrap_or(bytes);
    let mut parser = Parser { text, pos: 0, open: Vec::new() };
    if !parser.document() {
        return Err(NOT_JSON.into());
    }
    if text.iter().find(|byte| !is_space(**byte)) != Some(&b'{') {
        return Err(NOT_OBJECT.into());
    }
    Ok(())
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

struct Parser<'a> {
    text: &'a [u8],
    pos: usize,
    /// The open containers' closing brackets, innermost last.
    open: Vec<u8>,
}

enum Step {
    Bad,
    /// A complete value: a scalar or an empty container.
    Done,
    /// A non-empty container was opened; its first value comes next.
    Opened,
}

impl Parser<'_> {
    fn document(&mut self) -> bool {
        loop {
            match self.value() {
                Step::Bad => return false,
                Step::Opened => continue,
                Step::Done => match self.close_containers() {
                    Some(true) => continue,
                    Some(false) => return self.pos == self.text.len(),
                    None => return false,
                },
            }
        }
    }

    fn value(&mut self) -> Step {
        self.skip_space();
        let done = match self.peek() {
            Some(b'{') => return self.open_container(b'}'),
            Some(b'[') => return self.open_container(b']'),
            Some(b'"') => self.string(),
            Some(b't') => self.literal(b"true"),
            Some(b'f') => self.literal(b"false"),
            Some(b'n') => self.literal(b"null"),
            _ => self.number(),
        };
        if done { Step::Done } else { Step::Bad }
    }

    fn open_container(&mut self, close: u8) -> Step {
        self.pos += 1;
        self.skip_space();
        if self.eat(close) {
            return Step::Done;
        }
        self.open.push(close);
        if close == b'}' && !self.key() {
            return Step::Bad;
        }
        Step::Opened
    }

    // After a complete value: closes finished containers, then consumes a
    // comma (and the next key). Some(true) when another value follows,
    // Some(false) after the top-level value, None on bad syntax.
    fn close_containers(&mut self) -> Option<bool> {
        loop {
            self.skip_space();
            let Some(&close) = self.open.last() else { return Some(false) };
            if self.eat(close) {
                self.open.pop();
                continue;
            }
            if !self.eat(b',') {
                return None;
            }
            return (close == b']' || self.key()).then_some(true);
        }
    }

    fn key(&mut self) -> bool {
        self.skip_space();
        if self.peek() != Some(b'"') || !self.string() {
            return false;
        }
        self.skip_space();
        self.eat(b':')
    }

    fn string(&mut self) -> bool {
        self.pos += 1;
        while let Some(byte) = self.next() {
            match byte {
                b'"' => return true,
                b'\\' if !self.escape() => return false,
                0..0x20 => return false,
                _ => {}
            }
        }
        false
    }

    fn escape(&mut self) -> bool {
        match self.next() {
            Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => true,
            Some(b'u') => (0..4).all(|_| self.next().is_some_and(|b| b.is_ascii_hexdigit())),
            _ => false,
        }
    }

    // -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
    fn number(&mut self) -> bool {
        self.eat(b'-');
        if !self.eat(b'0') && self.digits() == 0 {
            return false;
        }
        if self.eat(b'.') && self.digits() == 0 {
            return false;
        }
        if self.eat(b'e') || self.eat(b'E') {
            let _ = self.eat(b'+') || self.eat(b'-');
            return self.digits() > 0;
        }
        true
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn literal(&mut self, word: &[u8]) -> bool {
        let matched = self.text[self.pos..].starts_with(word);
        self.pos += word.len();
        matched
    }

    fn peek(&self) -> Option<u8> {
        self.text.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let byte = self.peek();
        self.pos += 1;
        byte
    }

    fn eat(&mut self, byte: u8) -> bool {
        let matched = self.peek() == Some(byte);
        self.pos += usize::from(matched);
        matched
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(is_space) {
            self.pos += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn check(text: &[u8]) -> Result<()> {
        check_metadata(text)
    }

    #[test]
    fn accepts_what_json_parse_accepts() {
        let deep = format!("{{\"a\":{}{}}}", "[".repeat(100_000), "]".repeat(100_000));
        let valid: [&[u8]; 12] = [
            b"{}",
            b" \t\r\n{ \"a\" : [ 1 , 2 ] } \n",
            b"\xef\xbb\xbf{\"a\":1}",
            b"{\"a\":\"\\ud800\"}",
            b"{\"a\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uABCD\"}",
            b"{\"a\":1e400,\"b\":-0.5E-3,\"c\":[true,false,null],\"d\":0,\"e\":-0}",
            b"{\"a\":\"\xff\xe2\x82\"}",
            b"{\"a\":{},\"b\":[],\"c\":[{}]}",
            b"{\"a\":{\"b\":{\"c\":[1,[2,[3]]]}}}",
            b"{\"\":\"\x7f\"}",
            b"{\"a\":1E+2,\"b\":12.50e-0}",
            deep.as_bytes(),
        ];
        for text in valid {
            assert_eq!(check(text), Ok(()), "{}", String::from_utf8_lossy(text));
        }
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        let invalid: [&[u8]; 25] = [
            b"",
            b"   ",
            b"\xef\xbb\xbf\xef\xbb\xbf{}",
            b"{\"a\":1}\xff",
            b"{\"a\":",
            b"{} x",
            b"{\"a\":1,}",
            b"{\"a\":01}",
            b"{\"a\":-}",
            b"{\"a\":1.}",
            b"{\"a\":.5}",
            b"{\"a\":1e}",
            b"{\"a\":+1}",
            b"{\"a\":\"\\u12\"}",
            b"{\"a\":\"\\x\"}",
            b"{\"a\":\"\t\"}",
            b"{'a':1}",
            b"{\"a\" 1}",
            b"{\"a\":tru}",
            b"{1:1}",
            b"{,}",
            b"[1,]",
            b"{\"a\":[1 2]}",
            b"{\"a\":1}}",
            b"{\"a\":\"x",
        ];
        for text in invalid {
            assert_eq!(check(text), Err(Error(NOT_JSON.into())), "{}", String::from_utf8_lossy(text));
        }
    }

    #[test]
    fn requires_an_object() {
        for text in [&b"[]"[..], b"null", b"42", b"\"x\"", b" true ", b"[{}]"] {
            assert_eq!(check(text), Err(Error(NOT_OBJECT.into())), "{}", String::from_utf8_lossy(text));
        }
    }
}
