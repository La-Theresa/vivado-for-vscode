# Local Verification

Verified on September 27, 2026 with Windows, Node 24.13.1, the locally installed
VS Code, and Vivado 2018.3 at `D:/vivado/Vivado/2018.3`.

## Automated Checks

| Check | Result |
| --- | --- |
| TypeScript type checking | Passed |
| Unit tests | 28 passed, including runtime precedence, VCD parsing, ANSI LUT decoding, I/O validation/XDC escaping, design fingerprints, layout and preview CSP |
| VS Code Extension Host | Activation, dirty source/header diagnostics, clearing, cross-module mapping, finite simulation, right-side preview/I/O tabs and Run menu registration passed |
| Vivado smoke test | Tcl queue, 289 installed parts, independent syntax checks, elaboration, simulation, synthesis, implementation and bitstream passed |
| Reports | Utilization, timing, DRC and STATS metrics exported |
| Real XPR import | Device, top, simulation top, multiple include directories and defines round-tripped |
| Project synchronization | Empty project creation and incremental file addition/removal passed |
| Negative build | Invalid pin reported at the XDC line; conflicting bank voltages stopped placement with DRC BIVC-1 |
| Recovery | Failed build invalidated current bitstream state; corrected synthesis succeeded without stale implementation errors |
| Waveform reopening | Existing WDB opened with `open_wave_database` and signals added |
| Internal previews | Real VCD and synthesized netlist rendered in wide and narrow panels; filtering, cursor, radix, visibility, zoom, pan, search and connected-net highlighting passed |
| I/O Planning | Actual part pins/banks/standards, manual/list selection, XDC save/read, occupied-pin swaps, clearing/restoring, conflict guards and generated-XDC bitstream build passed |
| No-board case | Explicit missing-target error returned; no device was programmed |
| Runtime dependency audit | No known vulnerabilities reported at test time |

The full-flow artifact is retained at
`.test-work/smoke-xQyC3a/.vivado/project/counter.runs/impl_1/top.bit`.
Its simulation generated WDB and VCD and printed `VIVADO_TEST_PASS led=3`.
The complete successful tool log is `.test-work/smoke-xQyC3a/smoke-output.txt`.
The fixture is not an electrically verified board design.

## Version 0.2 Preview Verification

- The Extension Host test sets the workspace duration to `all` and the project
  duration to `1 us`, then simulates an endless-clock testbench. The generated
  Tcl contains `run 1 us`, the process exits, and a waveform tab opens in column 2.
  Reopening the preview reuses the existing tab.
- Synthesis exports `schematic.xml` with real primitive cells and opens a second
  preview tab in column 2. The full smoke test still completes implementation and
  bitstream generation after this export.
- Playwright tests the bundled preview with the actual CSP in installed Chrome at
  1100x720 and 360x740. Both generated fixtures (including a bus with X/Z values)
  and real tool output are exercised. No browser errors or page-width overflow
  were reported. External-viewer buttons dispatch the expected host action.
- Screenshots are retained under `.test-work/preview-browser` and were visually
  reviewed for framing and overlap. Narrow schematic panels need zoom or search
  to inspect individual cells.
- All preview JavaScript, CSS, the VCD parser WASM and dependency notices are
  bundled in the VSIX; no preview CDN is required.

## Compatibility Findings

- Vivado 2018.3 reports Tcl 8.5.14. The generators do not use Tcl 8.6 `lmap`.
- Both space-containing and Chinese-containing source/include paths compiled successfully.
- Tcl values are ASCII-escaped for reliable transmission through Windows sessions.
- Split GBK output characters are covered by a decoder test. Actual tool output
  encoding remains configurable; automatic system-locale detection is not implemented.
- Passing backslash paths through xsim's `--tclbatch` caused escape corruption.
  Tool-facing file arguments now use forward slashes.
- `report_timing_summary` in this installation does not accept `-force`.
- Native XPR files use repeated `VerilogDir` options and independent `Define` nodes.
- WDB is not a snapshot argument for the standalone xsim launcher. Static
  waveform viewing uses Vivado's `open_wave_database` command.
- A persistent session observed `NEEDS_REFRESH` change from `0` to `1` after an
  external source edit and a 1.5-second wait. Builds also compare content hashes.
- Both `--mt off` and `--mt auto` completed the small elaboration fixture.
  These concurrent single-run timings are not a controlled performance benchmark.
- `--relax` without an explicit timescale passed the tested fixture. The extension
  keeps an explicit `--timescale 1ns/1ps` for deterministic behavior.

## Version 0.3 I/O Verification

- The real-tool fixture synthesizes AND, OR, XOR and inverted logic followed by
  registers. Exported LUT `INIT` values select the expected American-style gate
  symbols, while buffers, flip-flops, GND and VCC retain their real connections.
- Vivado queried 210 bonded general-purpose package pins for `xc7a35tcsg324-1`,
  plus bank, pin-function, clock, differential-mate and I/O-standard metadata.
  No hard-coded package-pin list is used.
- Saving creates a separate owned XDC and automatically includes it after other
  constraints. Tests preserve the original board XDC, reject overwriting it,
  reject concurrent constraint edits and require synthesis after changing part.
  Two occupied pins can be swapped, cleared, restored and reread correctly.
- `get_ports -regexp` with escaped, anchored names round-trips bus bits.
  `reset_property` is not supported inside Vivado 2018.3 XDC, even though it
  works interactively. The exporter uses supported empty `set_property` values
  for clearing. `IOSTANDARD DEFAULT` is not accepted; clearing the value may
  subsequently report effective `LVCMOS18`. A query rejects new critical
  warnings/errors because `read_xdc` can return success after partial failure.
- Early synthesis in 2018.3 can warn that IOSTANDARD objects were not found for
  regexp-selected bus bits. Reading the same XDC in the synthesized design and
  implementation succeeds. The real-tool test also checks each package pin and
  I/O standard in the routed checkpoint, not only the existence of a bitstream.
- The generated-XDC project completes synthesis, implementation and bitstream:
  `.test-work/io-integration-apUhho/.vivado/project/counter.runs/impl_1/top.bit`.
  The real-tool log is `.test-work/io-integration-apUhho/io-test-output.txt`.
  The fixture still has an expected configuration-voltage warning and is not a
  board-ready design.
- Playwright tests real and generated netlist/device data at 1100x720 and 360x740:
  manual invalid/duplicate pin errors, picker bank/search filters, occupied-pin
  disabling, I/O-standard choices, Save/Reload messages, preserved drafts after
  conflicts, port focus and locking an obsolete device table. Real screenshots
  were visually reviewed under `.test-work/preview-browser`.
- The VS Code test confirms the new command queries the actual device and opens
  one reusable I/O Planning tab in column 2 alongside the existing previews.

## Version 0.3.1 Wheel Navigation

- Ctrl+wheel zooms the waveform around the mouse position without changing the
  selected cursor time or zooming the page. Toolbar zoom uses the same 1x-32x
  limits and retains the center time.
- Shift+wheel scrolls horizontally in both directions without changing scale.
  Pixel, line, page and already-horizontal wheel deltas are covered; unmodified
  wheel events retain native scrolling.
- Playwright tests actual modifier keys and mouse-wheel input at 1100x720 and
  360x740, plus synthetic delta modes and zoom/scroll boundaries. Generated VCD
  fixtures and the real `.test-work/smoke-xQyC3a` simulation output both passed.
  Cursor values, signal controls, schematic and I/O interactions still pass.
- Type checking and all 28 unit tests passed. Screenshots after wheel navigation
  are saved as `.test-work/preview-browser/waveform-wheel-1100.png` and
  `waveform-wheel-360.png`. This preview-only change does not require rerunning
  synthesis or simulation to reopen an existing waveform.

## Remaining Verification

Actual FPGA programming still requires a connected board. The retry prompt and
no-target path are implemented, but successful `program_hw_devices` has not been
tested. Exact `Place 30-876` reproduction was not part of this fixture; the common
message parser handles arbitrary Vivado IDs and the negative placement test used
`DRC BIVC-1`.

Manual visual review of every wizard and native Vivado-viewer interaction, other
Vivado releases, Linux, long paths, package-heavy SystemVerilog designs, and
board-specific voltage/pin assignments remain outside this initial test matrix.
