use std::io::Write;
use std::process::ExitCode;

use veritiles_pack::args::{self, Command};
use veritiles_pack::assets::assets;
use veritiles_pack::error::Result;
use veritiles_pack::pack::pack;
use veritiles_pack::verify::verify;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    match run(&argv) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            let _ = writeln!(std::io::stderr(), "{err}");
            ExitCode::FAILURE
        }
    }
}

fn run(argv: &[String]) -> Result<()> {
    match args::parse(argv)? {
        Command::Pack(args) => {
            let packed = pack(&args)?;
            println!("{}", packed.anchor);
            let (leaves, files, bytes) = (packed.leaf_count, packed.file_count, packed.descriptor_len);
            eprintln!("proofs: {}/ ({leaves} leaves, {files} files, descriptor {bytes} bytes)", args.out);
            if let Some(budget) = packed.tile_group {
                eprintln!("tile group: {budget} bytes");
            }
            eprintln!("map: {}", packed.map_cid);
            if let Some(unixfs) = packed.unixfs_cid {
                eprintln!("unixfs: {unixfs}");
            }
            Ok(())
        }
        Command::Assets(args) => {
            let bundle = assets(&args)?;
            if let Some(note) = bundle.budget_note() {
                eprintln!("{note}");
            }
            bundle.write(&args.out)?;
            println!("{}", bundle.anchor);
            Ok(())
        }
        Command::Verify(args) => {
            verify(&args)?;
            println!("verify OK");
            Ok(())
        }
    }
}
