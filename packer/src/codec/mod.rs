pub mod cbor;
pub mod cid;
pub mod varint;

/// sha2-256, the only hash the format uses.
pub const DIGEST_LENGTH: usize = 32;
pub type Digest = [u8; DIGEST_LENGTH];

/// JS `Number.MAX_SAFE_INTEGER`: the TS packer and client hold sizes and
/// offsets as JS numbers, so every value they accept stays at or below it.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
