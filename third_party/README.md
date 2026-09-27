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

## rust_vcd_wasm 0.1.6: Unresolved

The npm archive declares `MIT/Apache-2.0`, but contains no license text. Its
published `gitHead` is `1b568d01e823f6ca1e7e11f213f86110ad0f638c`.
The [corresponding upstream tree](https://github.com/msBRF65/rust_vcd_wasm/tree/1b568d01e823f6ca1e7e11f213f86110ad0f638c)
also lacks license files and a Cargo lockfile. `Cargo.toml` lists
`console_error_panic_hook`, `js-sys`, `vcd` and `wasm-bindgen`.

Before distributing the VSIX, obtain the applicable copyright/license texts and
the notices for the Rust code compiled into the prebuilt WASM, or replace it
with a dependency/build whose source and notices can be verified. Do not invent
an upstream copyright notice or treat an npm audit as a WASM dependency audit.
The release preflight intentionally fails while this remains unresolved.
