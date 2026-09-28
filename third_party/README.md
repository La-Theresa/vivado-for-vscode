# Supplemental Dependency Notices

The build collects license files from the actual bundled npm packages into
`dist/THIRD_PARTY_NOTICES.md`. It also writes `dist/license-audit.json` for the
release preflight. Neither document is a legal certification.

## @nodable/entities 3.0.0

The npm archive omits its MIT license file. `nodable-entities-LICENSE.txt` is an
unaltered copy of the [upstream repository license](https://github.com/nodable/val-parsers/blob/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/LICENSE)
at the npm release's `gitHead`, retrieved on September 27, 2026.
The fallback applies only to version 3.0.0;
review it again when updating this dependency.

## elkjs 0.12.0

Distributed under EPL-2.0. The bundle retains the packaged license text and
provides a [corresponding-source link](https://github.com/kieler/elkjs/tree/0.12.0).
ELK is bundled/minified, without local changes to its source. Review source and
notice obligations again when upgrading or modifying it.

## Self-Built VCD WASM

Version 0.4.1 replaces the unauditable precompiled `rust_vcd_wasm@0.1.6` package.
Its JavaScript glue and binary are not used or copied. The project-owned MIT
wrapper in `wasm/vcd-parser` uses the established `vcd@0.7.0` Rust parser and
`serde_json@1.0.145`, compiled with Rust 1.85.1 for `wasm32-unknown-unknown`.
The upstream `vcd` MIT text preserves Kevin Mehall's copyright.

[`wasm-notices.json`](wasm-notices.json) contains exact registry versions,
archive SHA-256 checksums, source locations and full upstream notice texts.
The collector checks each downloaded archive against the corresponding
`Cargo.lock` checksum. Texts are hashed and deduplicated, not replaced with
generic license templates. The application lockfile and pinned Rust library
lockfile are both covered, including optional/build/test and non-WASM platform
dependencies as a conservative superset. Their inclusion in the notice list
does not assert that they are linked into the WASM.

Rust runtime declarations include the toolchain's `COPYRIGHT`, MIT and Apache
texts, submodule notices for stdarch, portable-simd and backtrace, and all
registry crates in its library lockfile. Two special archive layouts are
handled explicitly:

- `r-efi` and `r-efi-alloc` provide their full MIT grant and copyright in
  `AUTHORS`; that file is retained unchanged.
- `fortanix-sgx-abi@0.5.0`, an SGX-only extra, omits its license file. Its MPL
  text is retrieved from the exact commit recorded in the archive's
  `.cargo_vcs_info.json`, with the Git blob hash checked. The supplemental
  source link is retained in the notices.

The VSIX includes the full generated `dist/THIRD_PARTY_NOTICES.md`, the
project MIT license and `dist/wasm-build.json`. The receipt ties the binary
hash to the wrapper, dependency lock, fixed toolchain and notice data.
Build and release checks reject stale or incomplete evidence and exercise
the real WASM ABI. No prebuilt fallback is permitted.

See the [reproducible build instructions](../wasm/README.md). Updating Rust or
either lockfile requires regenerating and reviewing notices. These checks
document provenance and notice coverage; they do not constitute legal advice,
a vulnerability audit of Rust dependencies or a guarantee of all license
obligations.
