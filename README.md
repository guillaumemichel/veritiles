# anymirror

Verified content over dumb hosts. A reader fetches from any HTTP host — a
CDN, an S3 bucket, GitHub Pages, a mirror nobody vouches for — and verifies
every byte against a single trust anchor, a CID, before handing it over.
Publishing is `cp`; mirroring is `rsync`.

| package                                                    | what it is                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`anymirror`](packages/anymirror/README.md)                | the readers: a large file by ranges, a small file whole, a bundle by path; hints as a plugin        |
| [`@anymirror/router`](packages/router/README.md)           | the router contract: where a CID's bytes may live. Types only                                       |
| [`@anymirror/fisl-router`](packages/fisl-router/README.md) | a router over a FISL index                                                                          |
| [`veritiles`](packages/veritiles/README.md)                | verified maps: a PMTiles `Source`, a MapLibre protocol for styles, sprites and glyphs, a script tag |
| [`anymirror-pack`](packer/README.md)                       | the packer: makes the proofs a publisher uploads beside the content (Rust, not on npm)              |

[`SPEC.md`](SPEC.md) defines the anchors, the proof formats, what a reader
must check, hints documents and routers.

## Development

```sh
npm ci
npm test               # unit, integration and golden tests, the bundle-size
                       # budgets, end to end through the real pmtiles reader
npm run typecheck
npm run build          # each package's dist/, and veritiles' script tag
npm run test:packages  # after a build: the tarballs installed and imported
                       # as an app sees them
```

The tests read each package's sources directly, through the
`anymirror-source` export condition, so they need no build. The readers have
no dependencies by design. Canonical IPLD implementations (`multiformats`,
`@ipld/dag-cbor`, `@ipld/dag-pb`, `@ipld/car`, `ipfs-unixfs-importer`,
`blockstore-core`) and `pmtiles` are dev dependencies only: they cross-check
CID, DRISL/MASL, CAR and UnixFS output in the tests.

`tools/pack.ts` is a TypeScript port of the packer, for the tests: it writes
the same bytes as `anymirror-pack` but reads its input into memory, up to
about 2 GiB (`npm run pack -- <input>`). The packer's own checks:

```sh
cargo build --release --manifest-path packer/Cargo.toml
npm run test:diff      # anymirror-pack against tools/pack.ts, byte for byte
```

Releases follow [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
