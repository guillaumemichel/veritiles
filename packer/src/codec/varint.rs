// Unsigned LEB128, as multiformats and protobuf use it.

pub fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push(value as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_leb128() {
        let encode = |value| {
            let mut out = Vec::new();
            push_varint(&mut out, value);
            out
        };
        assert_eq!(encode(0), [0]);
        assert_eq!(encode(127), [0x7f]);
        assert_eq!(encode(300), [0xac, 0x02]);
        assert_eq!(encode(u64::MAX).len(), 10);
    }
}
