// The hashing pass with its optional UnixFS side. Without a full CAR, the
// UnixFS builder runs inline on chunk digests (no blocks are kept). With
// one, a writer thread runs the builder and streams each section to the CAR
// as digests arrive; the bounded queue lets a slow output disk throttle the
// pass instead of buffering.
use std::sync::mpsc::sync_channel;
use std::thread;

use crate::car::CarWriter;
use crate::codec::Digest;
use crate::codec::cid::CidBytes;
use crate::error::{Error, Result};
use crate::input::Input;
use crate::pipeline::{Hashed, hash_and_write_shards};
use crate::plan::Leaves;
use crate::proof::tree::Layout;
use crate::unixfs::Builder;

// Steps of chunk digests queued for the CAR writer (a step is up to 256 MiB
// of input).
const CAR_QUEUE: usize = 2;

/// What the pass builds besides the proofs.
pub enum UnixFs {
    Off,
    /// The UnixFS root CID only.
    Root,
    /// The root CID and every block, into the CAR.
    Car(CarWriter),
}

pub struct Pass {
    pub proofs: Hashed,
    pub unixfs: Option<CidBytes>,
    /// Every block written; the header waits for `CarWriter::commit`.
    pub car: Option<CarWriter>,
}

pub fn hash_pass(input: &Input, leaves: &Leaves, layout: &Layout, out: &str, unixfs: UnixFs) -> Result<Pass> {
    match unixfs {
        UnixFs::Off => {
            let proofs = hash_and_write_shards(input, leaves, layout, out, None)?;
            Ok(Pass { proofs, unixfs: None, car: None })
        }
        UnixFs::Root => hash_with_root(input, leaves, layout, out),
        UnixFs::Car(car) => hash_with_car(input, leaves, layout, out, car),
    }
}

fn hash_with_root(input: &Input, leaves: &Leaves, layout: &Layout, out: &str) -> Result<Pass> {
    let mut builder = Builder::new();
    let mut discard = |_: &CidBytes, _: &[u8]| Ok(());
    let mut sink = |digests: Vec<Digest>| builder.push_chunks(input.bytes(), &digests, &mut discard);
    let proofs = hash_and_write_shards(input, leaves, layout, out, Some(&mut sink))?;
    let root = builder.finish(&mut discard)?;
    Ok(Pass { proofs, unixfs: Some(root), car: None })
}

fn hash_with_car(input: &Input, leaves: &Leaves, layout: &Layout, out: &str, car: CarWriter) -> Result<Pass> {
    let bytes = input.bytes();
    let (sender, receiver) = sync_channel::<Vec<Digest>>(CAR_QUEUE);
    thread::scope(|scope| {
        let writer = scope.spawn(move || {
            let mut car = car;
            let mut builder = Builder::new();
            for digests in receiver {
                builder.push_chunks(bytes, &digests, &mut |cid, block| car.block(cid, block))?;
            }
            Ok::<_, Error>((builder, car))
        });
        let mut sink = |digests| sender.send(digests).map_err(|_| Error::from("CAR writer stopped"));
        let proofs = hash_and_write_shards(input, leaves, layout, out, Some(&mut sink));
        drop(sender);
        // A CAR write error is the cause of a stopped writer, so it wins.
        let (builder, mut car) = writer.join().expect("CAR writer panicked")?;
        let proofs = proofs?;
        let root = builder.finish(&mut |cid, block| car.block(cid, block))?;
        Ok(Pass { proofs, unixfs: Some(root), car: Some(car) })
    })
}
