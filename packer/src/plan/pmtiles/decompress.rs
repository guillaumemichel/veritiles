// PMTiles internal decompression with Node's zlib semantics, which define
// what tools/pack.ts accepts:
// - gzip: members are decoded back to back; decoding stops cleanly at the
//   end of input or at a 0x00 byte after a member (padding), and any other
//   trailing byte must start a valid member (node_zlib.cc).
// - brotli: the stream ends at its last meta-block; trailing bytes are
//   ignored; large-window streams are rejected (the C decoder's default).
// - zstd: exactly one complete frame, checked before decoding: Node 22 and
//   24 disagree on truncated frames and on bytes after a frame.
// Output over 256 MiB fails, as Node's maxOutputLength does in tools/pack.ts:
// a tiny block can otherwise inflate past memory.
use std::borrow::Cow;

use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
use flate2::{Decompress, FlushDecompress, Status};
use zstd::zstd_safe::{DCtx, InBuffer, OutBuffer};

use crate::error::Result;

// The header's internal compression codes.
pub const UNKNOWN: u8 = 0;
pub const NONE: u8 = 1;
pub const GZIP: u8 = 2;
pub const BROTLI: u8 = 3;
pub const ZSTD: u8 = 4;
/// Node's zlib output buffer size (zlib.constants.Z_DEFAULT_CHUNK).
const NODE_CHUNK: usize = 16 * 1024;
const ZSTD_MAGIC: u32 = 0xFD2F_B528;
const GZIP_WINDOW_BITS: u8 = 15;
/// Largest decompressed directory or metadata block.
pub const MAX_OUTPUT: usize = 256 << 20;

/// Decompresses a directory or metadata section stored with `compression`
/// (the header's internal compression code).
pub fn decompress(bytes: &[u8], compression: u8) -> Result<Cow<'_, [u8]>> {
    decompress_capped(bytes, compression, MAX_OUTPUT)
}

/// `decompress` failing once the output exceeds `cap` bytes.
pub fn decompress_capped(bytes: &[u8], compression: u8, cap: usize) -> Result<Cow<'_, [u8]>> {
    let (name, decoded) = match compression {
        UNKNOWN | NONE => return Ok(Cow::Borrowed(bytes)),
        GZIP => ("gzip", gunzip(bytes, cap)),
        BROTLI => ("brotli", unbrotli(bytes, cap)),
        ZSTD => ("zstd", unzstd(bytes, cap)),
        _ => return Err(format!("unsupported PMTiles compression {compression}").into()),
    };
    decoded.map(Cow::Owned).ok_or_else(|| format!("PMTiles {name} decompression failed").into())
}

fn gunzip(mut input: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        input = &input[inflate_member(input, &mut out, cap)?..];
        if input.first().is_none_or(|&byte| byte == 0) {
            return Some(out);
        }
    }
}

// Inflates one gzip member onto `out`; returns the bytes it consumed.
fn inflate_member(input: &[u8], out: &mut Vec<u8>, cap: usize) -> Option<usize> {
    let mut inflater = Decompress::new_gzip(GZIP_WINDOW_BITS);
    loop {
        out.reserve(NODE_CHUNK);
        let before = (inflater.total_in(), inflater.total_out());
        let rest = &input[inflater.total_in() as usize..];
        let status = inflater.decompress_vec(rest, out, FlushDecompress::Finish).ok()?;
        if out.len() > cap {
            return None;
        }
        if status == Status::StreamEnd {
            return Some(inflater.total_in() as usize);
        }
        if (inflater.total_in(), inflater.total_out()) == before {
            return None; // input ended inside the member
        }
    }
}

fn unbrotli(input: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut state =
        BrotliState::new_strict(StandardAlloc::default(), StandardAlloc::default(), StandardAlloc::default());
    let (mut available_in, mut input_offset, mut total_out) = (input.len(), 0, 0);
    let mut out = Vec::new();
    let mut buffer = vec![0; NODE_CHUNK];
    loop {
        let (mut available_out, mut output_offset) = (buffer.len(), 0);
        let result = BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            input,
            &mut available_out,
            &mut output_offset,
            &mut buffer,
            &mut total_out,
            &mut state,
        );
        out.extend_from_slice(&buffer[..output_offset]);
        if out.len() > cap {
            return None;
        }
        match result {
            BrotliResult::ResultSuccess => return Some(out),
            BrotliResult::NeedsMoreOutput => continue,
            BrotliResult::NeedsMoreInput | BrotliResult::ResultFailure => return None,
        }
    }
}

fn unzstd(input: &[u8], cap: usize) -> Option<Vec<u8>> {
    if !is_one_zstd_frame(input) {
        return None;
    }
    let mut context = DCtx::create();
    let mut source = InBuffer::around(input);
    let mut out = Vec::new();
    let mut buffer = vec![0; NODE_CHUNK];
    loop {
        let mut target = OutBuffer::around(&mut buffer[..]);
        let frame_left = context.decompress_stream(&mut target, &mut source).ok()?;
        let written = target.pos();
        out.extend_from_slice(&buffer[..written]);
        if out.len() > cap {
            return None;
        }
        if frame_left == 0 {
            return Some(out);
        }
    }
}

// Whether `input` is one zstd frame (RFC 8878 §3.1.1) and nothing else: the
// header, blocks up to the last one, the checksum when flagged. A skippable
// frame is not one. Decoding checks the rest.
fn is_one_zstd_frame(input: &[u8]) -> bool {
    if input.len() < 5 || input[..4] != ZSTD_MAGIC.to_le_bytes() {
        return false;
    }
    let descriptor = usize::from(input[4]);
    let single_segment = descriptor >> 5 & 1;
    let mut at = 5 + (1 - single_segment) + [0, 1, 2, 4][descriptor & 3] + [single_segment, 2, 4, 8][descriptor >> 6];
    loop {
        let Some(&[b0, b1, b2]) = input.get(at..at + 3) else { return false };
        let header = u32::from_le_bytes([b0, b1, b2, 0]) as usize;
        at += 3 + match header >> 1 & 3 {
            1 => 1, // RLE: one byte, repeated
            3 => return false,
            _ => header >> 3,
        };
        if header & 1 == 1 {
            return at + (descriptor >> 2 & 1) * 4 == input.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::GzEncoder;

    use super::*;
    use crate::error::Error;

    const BROTLI_HELLO: &[u8] = &[0x0b, 0x02, 0x80, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x03];

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn zstd(bytes: &[u8]) -> Vec<u8> {
        zstd::bulk::compress(bytes, 3).unwrap()
    }

    fn decoded(bytes: &[u8], compression: u8) -> Result<Vec<u8>> {
        decompress(bytes, compression).map(Cow::into_owned)
    }

    fn failed(name: &str) -> Result<Vec<u8>> {
        Err(Error(format!("PMTiles {name} decompression failed")))
    }

    #[test]
    fn stored_and_unknown_codes() {
        assert_eq!(decoded(b"raw", UNKNOWN), Ok(b"raw".to_vec()));
        assert_eq!(decoded(b"raw", NONE), Ok(b"raw".to_vec()));
        assert_eq!(decoded(b"raw", 5), Err(Error("unsupported PMTiles compression 5".into())));
    }

    #[test]
    fn gzip_members_padding_and_junk() {
        let (hello, world) = (gzip(b"hello"), gzip(b"world"));
        assert_eq!(decoded(&[hello.clone(), world.clone()].concat(), GZIP), Ok(b"helloworld".to_vec()));
        assert_eq!(decoded(&[hello.clone(), vec![0, b'j']].concat(), GZIP), Ok(b"hello".to_vec()));
        assert_eq!(decoded(&[hello.clone(), vec![0], world].concat(), GZIP), Ok(b"hello".to_vec()));
        assert_eq!(decoded(&[hello.clone(), b"junk".to_vec()].concat(), GZIP), failed("gzip"));
        assert_eq!(decoded(&[hello.clone(), vec![0x1f]].concat(), GZIP), failed("gzip"));
        assert_eq!(decoded(&hello[..hello.len() - 1], GZIP), failed("gzip"));
        assert_eq!(decoded(&[], GZIP), failed("gzip"));
        let big = vec![7; 100_000];
        assert_eq!(decoded(&gzip(&big), GZIP), Ok(big));
    }

    #[test]
    fn brotli_ignores_trailing_bytes() {
        assert_eq!(decoded(BROTLI_HELLO, BROTLI), Ok(b"hello".to_vec()));
        assert_eq!(decoded(&[BROTLI_HELLO, b"junk"].concat(), BROTLI), Ok(b"hello".to_vec()));
        assert_eq!(decoded(&BROTLI_HELLO[..5], BROTLI), failed("brotli"));
        assert_eq!(decoded(&[], BROTLI), failed("brotli"));
        assert_eq!(decoded(b"hello world", BROTLI), failed("brotli"));
        assert_eq!(decoded(&[6], BROTLI), Ok(Vec::new()));
    }

    fn zstd_with_checksum(bytes: &[u8]) -> Vec<u8> {
        let mut compressor = zstd::bulk::Compressor::new(3).unwrap();
        compressor.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true)).unwrap();
        compressor.compress(bytes).unwrap()
    }

    #[test]
    fn zstd_takes_exactly_one_complete_frame() {
        let (hello, world) = (zstd(b"hello"), zstd(b"world"));
        assert_eq!(decoded(&hello, ZSTD), Ok(b"hello".to_vec()));
        let checked = zstd_with_checksum(b"hello");
        assert_eq!(decoded(&checked, ZSTD), Ok(b"hello".to_vec()));
        let full = zstd(&[3; NODE_CHUNK]);
        assert_eq!(decoded(&full, ZSTD), Ok(vec![3; NODE_CHUNK]));
        let blocks: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        assert_eq!(decoded(&zstd(&blocks), ZSTD), Ok(blocks));
        let skippable = [0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 9];
        for broken in [
            [hello.clone(), world].concat(),
            [hello.clone(), b"junk".to_vec()].concat(),
            [full, vec![0]].concat(),
            hello[..hello.len() - 1].to_vec(),
            checked[..checked.len() - 1].to_vec(),
            Vec::new(),
            b"hello world".to_vec(),
            skippable.to_vec(),
            [&skippable[..], &hello].concat(),
        ] {
            assert_eq!(decoded(&broken, ZSTD), failed("zstd"), "{broken:?}");
        }
    }

    // A frame of one block (RFC 8878 §3.1.1): the frame content size field
    // of `fcs_code`, a window descriptor unless `single_segment`, a zero
    // dictionary ID of `did_code`; `kind` 0 is a raw block, 1 an RLE one.
    fn frame(content: &[u8], fcs_code: u8, single_segment: bool, did_code: u8, kind: u32) -> Vec<u8> {
        let mut frame = ZSTD_MAGIC.to_le_bytes().to_vec();
        frame.push(fcs_code << 6 | u8::from(single_segment) << 5 | did_code);
        if !single_segment {
            frame.push(0); // a 1 KiB window
        }
        frame.resize(frame.len() + [0, 1, 2, 4][usize::from(did_code)], 0);
        let fcs = content.len() as u64 - if fcs_code == 1 { 256 } else { 0 };
        frame.extend(&fcs.to_le_bytes()[..[usize::from(single_segment), 2, 4, 8][usize::from(fcs_code)]]);
        let header = (content.len() as u32) << 3 | kind << 1 | 1;
        frame.extend(&header.to_le_bytes()[..3]);
        frame.extend(if kind == 1 { &content[..1] } else { content });
        frame
    }

    #[test]
    fn zstd_header_fields_of_every_size() {
        for fcs_code in 0..4 {
            for single_segment in [false, true] {
                let content = vec![b'x'; if single_segment && fcs_code == 0 { 255 } else { 300 }];
                for (did_code, kind) in [(0, 0), (1, 1), (2, 0), (3, 1)] {
                    let whole = frame(&content, fcs_code, single_segment, did_code, kind);
                    let case = format!("fcs {fcs_code}, single segment {single_segment}, did {did_code}");
                    assert_eq!(decoded(&whole, ZSTD), Ok(content.clone()), "{case}");
                    assert_eq!(decoded(&whole[..whole.len() - 1], ZSTD), failed("zstd"), "{case}");
                    assert_eq!(decoded(&[whole, vec![0]].concat(), ZSTD), failed("zstd"), "{case}");
                }
            }
        }
        let reserved = frame(b"x", 0, true, 0, 3);
        assert_eq!(decoded(&reserved, ZSTD), failed("zstd"));
    }

    // A brotli stream of uncompressed meta-blocks (RFC 7932 §9.2): window
    // bit 0, then per block ISLAST 0, MNIBBLES 4, MLEN−1 in 16 bits,
    // ISUNCOMPRESSED 1, padding to a byte, the bytes; ISLAST + ISLASTEMPTY.
    fn brotli(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut bits = 1u32; // the window bit, already written
        for block in bytes.chunks(1 << 16) {
            let header = ((block.len() as u32 - 1) << 3) | (1 << 19);
            let word = header << bits;
            let total = bits + 20;
            out.extend_from_slice(&word.to_le_bytes()[..total.div_ceil(8) as usize]);
            out.extend_from_slice(block);
            bits = 0;
        }
        out.push(0b11 << bits);
        out
    }

    // Node's maxOutputLength: exactly the cap passes, one byte more fails.
    #[test]
    fn output_over_the_cap_fails() {
        let cap = 3 * NODE_CHUNK + 5;
        type Encoder = fn(&[u8]) -> Vec<u8>;
        let encoders: [(u8, &str, Encoder); 3] =
            [(GZIP, "gzip", gzip), (BROTLI, "brotli", brotli), (ZSTD, "zstd", zstd)];
        for (code, name, encode) in encoders {
            let at_cap = vec![1; cap];
            assert_eq!(decompress_capped(&encode(&at_cap), code, cap).map(Cow::into_owned), Ok(at_cap), "{name}");
            let over = encode(&vec![1; cap + 1]);
            assert_eq!(decompress_capped(&over, code, cap).map(Cow::into_owned), failed(name), "{name}");
        }
        assert_eq!(decompress_capped(&[0; 10], NONE, 5).map(Cow::into_owned), Ok(vec![0; 10]));
    }

    #[test]
    fn the_real_cap_is_256_mib() {
        let at_cap = zstd(&vec![0; MAX_OUTPUT]);
        assert_eq!(decompress(&at_cap, ZSTD).unwrap().len(), MAX_OUTPUT);
        let over = zstd(&vec![0; MAX_OUTPUT + 1]);
        assert_eq!(decompress(&over, ZSTD).map(Cow::into_owned), failed("zstd"));
    }
}
