pub mod args;
pub mod assets;
pub mod car;
pub mod codec;
pub mod error;
pub mod input;
pub mod manifest;
pub(crate) mod nodefs;
pub mod pack;
pub(crate) mod pass;
pub mod pipeline;
pub mod plan;
pub mod proof;
pub(crate) mod scan;
pub mod unixfs;
pub mod verify;

// File offsets and lengths are u64 and index the input map as usize.
const _: () = assert!(usize::BITS == 64, "anymirror-pack needs a 64-bit target");
