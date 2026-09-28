# Self-Built VCD Parser

The extension bundles `dist/vivado_vcd_parser.wasm`. End users do not install
Rust or download anything to view waveforms. The wrapper is project-owned MIT
source; VCD tokenization is performed by the upstream `vcd` crate, not a custom
JavaScript parser or the former `rust_vcd_wasm` package.

## Build From Source

Install Node.js 22 or later, npm, rustup and the host platform's Rust build
prerequisites (MSVC C++ Build Tools on Windows). From the repository root:

```sh
rustup toolchain install 1.85.1 --profile minimal --component rust-src --target wasm32-unknown-unknown
npm ci
npm run build:wasm
npm test
npm run package
```

`rust-toolchain.toml` and `Cargo.lock` are source-controlled. Cargo builds with
`--locked`, release optimization, LTO and an abort-on-panic policy. Path
prefixes are remapped, and linear memory is capped at 256 MiB. `npm test` and
the extension build also build the WASM automatically if a verified artifact
is not already available. A stale, missing or changed binary is not accepted.

Normal builds use the committed notice data and do not need to fetch license
texts. Cargo may fetch pinned crates/toolchain components on a fresh machine.
An explicitly configured `CARGO_HOME`/`RUSTUP_HOME` is respected; otherwise an
existing repository-local `.tools/cargo` and `.tools/rustup` installation can
be used without changing global PATH.

## Verification

```sh
npm run verify:wasm
```

This rebuilds in a new, empty target directory and compares the entire WASM's
SHA-256 with the existing verified artifact. It proves byte-for-byte
repeatability on the current host/toolchain, not cross-platform reproducibility.
The receipt records the compiler identity, target, source/lock/notice hashes,
memory limit and binary hash, without a build timestamp.

The tests execute the actual binary through the same TypeScript adapter as the
extension. They check aliases, X/Z extension, buses, bit selects, real/string
values, EOF changes, exact counter transitions, invalid input, preview limits
and repeated ABI allocation/free. Rust unit tests can also be run with
`cargo test --locked` from `wasm/vcd-parser`.

## Updating Dependencies

After intentionally changing the Rust version or lockfile, run:

```sh
npm run licenses:wasm
npm run build:wasm
npm run verify:wasm
```

The notice generator uses `tar`, downloads exact crate archives, validates
registry checksums, and preserves their actual license/copyright files.
Review the changes to `third_party/wasm-notices.json` before distribution,
including platform-only entries and newly introduced license obligations.
It fails rather than inventing a grant when evidence is missing. See
[`third_party/README.md`](../third_party/README.md) for coverage and exceptions.
The release preflight also verifies that the full Rust notices reach the
packaged notice document.

## ABI and Limits

ABI version 1 has no host imports. The exports are `memory`,
`vcd_abi_version`, `vcd_alloc`, `vcd_parse` and `vcd_free`. Input is UTF-8.
The parse result is an owned buffer containing a little-endian u32 byte count
followed by JSON with either `data` or `error`. Only module-allocated pointers
and their exact lengths may be passed back to the module.

The host caches compiled code but creates a fresh instance for every parse.
Aliases reference one shared timeline. Parser limits are 8 MiB input, 2048
signals, 4096 bits per signal, 64 scope levels, 500000 changes, a conservative
32 MiB expanded-timeline budget and timestamps no larger than 2^53-1. These
are synchronous preview limits, not a streaming or full simulator interface.
An oversized/malformed trace reports an error and can still be viewed with
the external WDB workflow. A trapped instance is discarded, not reused.
