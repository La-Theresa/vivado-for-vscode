# Vivado for VS Code

A local-first VS Code extension for Verilog/SystemVerilog development with an installed Vivado toolchain. The initial compatibility target is Windows and Vivado 2018.3. Language highlighting is provided by `mshr-h.veriloghdl`; this extension does not register competing language IDs.

## Quick Start

1. Install the generated VSIX using **Extensions: Install from VSIX**.
2. Open a local, trusted workspace folder.
3. Set `vivado.installPath` to the Vivado version directory, for example `D:/vivado/Vivado/2018.3`. Otherwise detection checks `XILINX_VIVADO`, PATH and common installation directories.
4. Run **Vivado: New Project** or **Vivado: Import XPR Project**. Select a part from the installed-device list.
5. Add files from Explorer or the Vivado sidebar. Set the design top or simulation top from a source file's context menu.
6. Use the play button at the top right of an HDL editor to run simulation. The adjacent menu includes synthesis, implementation, bitstream generation and previews. During a run, the play button becomes Stop.

The status bar shows the detected Vivado version. Diagnostics appear in Problems, tool output appears in the Vivado Output channel, and simulation output also appears in a terminal. Build notifications and the status bar offer cancellation.

To avoid duplicate lint results from the highlighting extension, set `verilog.linting.linter` to `none` yourself. This extension does not change another extension's settings.

## Project Configuration

Create `vivado-project.json` at the workspace root:

```json
{
  "version": 1,
  "name": "my_project",
  "part": "xc7a35tcsg324-1",
  "top": "top",
  "sources": ["rtl/packages.sv", "rtl/**/*.{v,sv,vh,svh}"],
  "constraints": ["constraints/**/*.xdc"],
  "simulation": ["sim/**/*.{v,sv}"],
  "simulationTop": "tb",
  "simulationRunTime": "1 us",
  "includeDirs": ["include"],
  "defines": ["WIDTH=4"],
  "exclude": []
}
```

Paths are relative to the workspace; absolute paths and external file references are accepted. Patterns are expanded in their declared order, with deterministic ordering inside each pattern and duplicate removal. Put SystemVerilog packages before their users. Include memory/data files in `sources` when they are build inputs, so their content participates in stale-build detection.

New and imported projects explicitly include `"simulationRunTime": "1 us"`. For existing projects, this field is optional: the priority is **project `simulationRunTime` > VS Code `vivado.sim.runTime` > `1 us`**. Use `"all"` only when the testbench ends itself (for example with `$finish`) or you intend to cancel it. The selected duration and its source are printed before each simulation. Changes apply to the next run, not an already running simulator.

The generated project lives under `.vivado/project`, scripts under `.vivado/scripts`, reports under `.vivado/reports`, and simulations under `.vivado/sim`. Add `.vivado/` to your project's ignore file. Removing a file from the sidebar changes configuration and exclusions only; it never deletes the source file. Add a removed file again to remove its exact exclusion.

XPR import preserves file references, the device, tops, include paths and defines. It does not copy files or reproduce run strategies, custom Tcl hooks, per-file properties, library assignments or additional custom file sets. Review the imported configuration and Output warnings.

## Workflows

- **Live checking:** edits are debounced for 500 ms. Dirty editor contents and headers are copied to a workspace-specific temporary snapshot. Each syntax check has an independent compiler directory; checks are limited to two simultaneous processes by default. Diagnostics map back to original files.
- **Cross-module checking:** saving or two seconds of idle time compiles design sources and elaborates the configured design top. The explicit default timescale is `1ns/1ps`. **Check Project** checks all design and simulation source files independently before elaboration.
- **Build:** Synthesize, Implement, Generate Bitstream and Build All synchronize file sets before launching an isolated batch process. A content fingerprint plus Vivado run status decides when synthesis needs resetting; implementation is reset before rerunning. Failures and cancellation invalidate the current bitstream state.
- **Reports:** Show Reports displays utilization, WNS/TNS/WHS/THS and the DRC report. Full text reports remain under `.vivado/reports`. These are snapshots of the last completed report generation, not live timing results.
- **Simulation:** a configured or discovered testbench is compiled with `glbl.v` and the installed Xilinx simulation libraries. The default is `run 1 us`. Successful runs produce both WDB and VCD and open an internal waveform preview to the right of the editor.
- **Waveform preview:** **Preview Waveform to the Side** reopens the last successful simulation in VS Code. It supports signal filtering, visibility checkboxes, zoom, a time cursor with values, and binary/hex/unsigned display. Over the waveform, **Ctrl + wheel up/down** zooms in/out around the pointer (1x to 32x), and **Shift + wheel down/up** scrolls right/left. Unmodified wheel scrolling is unchanged; the toolbar buttons remain available. The preview preserves aliases and X/Z states. **Open WDB in Waveform Viewer** remains available for the native Vivado viewer; **Open VCD** retains the external-editor workflow.
- **Schematic preview:** successful synthesis exports the real synthesized primitive cells, ports and nets, then opens **Preview Synthesized Schematic to the Side**. American-style ANSI distinctive symbols represent AND/NAND, OR/NOR, XOR/XNOR, buffers/inverters, flip-flops, latches and multiplexers. LUT gates are identified from their actual `INIT` truth tables, including supported input inversions; arbitrary complex LUTs and other primitives retain labeled functional blocks. Pan/zoom, cell search and connected-net highlighting are available. This is a synthesized netlist view, not the native Vivado RTL schematic or device floorplan. Source changes require another synthesis.
- **I/O Planning:** after synthesis, click an input/output port in the schematic, its table toolbar button, or **Vivado: I/O Planning** in the Run menu. A table opens in the same right-hand editor group, with package pins and I/O standards queried from the actual project part. Saved constraints are used by subsequent builds.
- **Hardware:** Program Device checks for a current bitstream, connects to the server, lets you choose a target/device, and requests confirmation before programming. Missing targets produce a retry prompt. Actual programming requires a connected board.
- **GUI fallback:** Open Project in Vivado GUI synchronizes the generated project first. Close the GUI project before building from VS Code; both applications must not modify the same generated project concurrently. Keep durable project settings in `vivado-project.json`.

Build, simulation and programming commands ask before saving modified workspace files. Syntax checks never save your files. Workspace trust is required because HDL tools and project constraints can execute code.

## I/O Planning

1. Run **Vivado: Synthesize**. After upgrading from version 0.2, synthesize once again to export symbol properties and establish a current design snapshot.
2. Open **Vivado: I/O Planning**, or click a top-level schematic port to select its row.
3. Enter a **Package Pin** manually, or click the row's list icon. The picker searches actual package pins by name/function, filters by bank, and marks occupied pins. Reserved/power pins are excluded. The table shows direction, bank, pin function and an I/O-standard selector.
4. Choose the I/O standard appropriate for your board. Invalid pins, duplicate assignments and standards unsupported by the bank/direction block saving. Incomplete assignments and mixed nominal bank voltages are warnings.
5. Click **Save Constraints** and choose a new `.xdc` inside the workspace, for example `constraints/io-planning.xdc`. The extension automatically records `"ioConstraints": "constraints/io-planning.xdc"` in `vivado-project.json`. Do not add this field until the file exists.
6. Run **Implement** or **Generate Bitstream**. Check Vivado DRC and your board's schematic before programming.

The designated `ioConstraints` file is synchronized last with `PROCESSING_ORDER LATE`, including when it already matches a constraints glob. It overrides package-pin and I/O-standard assignments for the listed ports, without changing the original XDC files or their timing constraints. Only files previously generated by I/O Planning can be overwritten; existing hand-written constraints are protected. Two occupied pins can be exchanged by editing their values before saving.

Use **Reload I/O Planning** after external constraint changes; reloading asks before discarding unsaved table edits. Changing the part or top locks an open table until a new synthesis and reload. Other source/constraint changes are checked again before saving, so an outdated snapshot cannot overwrite a newer configuration. Unsaved table edits are not retained after closing the tab.

This is package-pin planning, not a board-aware electrical sign-off tool. Incomplete drafts may be saved, but board voltages, differential pairing, clock routing, configuration voltages and timing still require verification. Vivado 2018.3 can report an effective default I/O standard after an explicit assignment is cleared; that value does not prove compatibility with the board.

## Settings

| Setting | Default |
| --- | --- |
| `vivado.installPath` | automatic detection |
| `vivado.outputEncoding` | `utf8`; use `gbk` if local output is garbled |
| `vivado.lint.onType` | `true` |
| `vivado.lint.debounceMs` | `500` |
| `vivado.lint.elaborate` | `onIdle`; also `onSave` / `none` |
| `vivado.lint.maxParallel` | `2` |
| `vivado.build.jobs` | `4` |
| `vivado.sim.defaultTimescale` | `1ns/1ps` |
| `vivado.sim.runTime` | `1 us`; fallback if the project has no `simulationRunTime` |
| `vivado.hw.serverUrl` | `localhost:3121` |

## Development and Tests

```text
npm ci
npm run check
npm test
npm run compile
npm run test:vivado
npm run test:extension
npm run test:preview
npm run test:io
npm run package
```

Press F5 in this repository to launch an Extension Development Host with the included example. `npm run test:vivado -- --quick` skips synthesis/implementation. `npm run test:edges -- --negative-build --hardware` covers path handling, elaborator options, failed builds, recovery and no-board behavior. The hardware test only queries targets and never programs devices.

`npm run test:io` checks real LUT symbol identification, part-specific pin queries, XDC round trips, pin swaps, clearing/restoring assignments, conflict guards and a complete bitstream build. Add `-- --quick` to skip the final implementation/bitstream stage.

The extension-host test uses a separate VS Code profile and extension directory under `.test-work`; it does not alter your daily VS Code settings. Set `VSCODE_EXECUTABLE` to override the local test executable and `VIVADO_PATH` to override detection for tool tests. Tests retain their generated projects and logs under `.test-work` for inspection.

The preview browser test uses a locally installed Chrome by default (`PREVIEW_BROWSER=msedge` also works), tests wide/narrow panels, and writes screenshots under `.test-work/preview-browser`. It does not use a remote renderer. Waveform parsing uses `rust_vcd_wasm`; schematic layout uses ELK. All preview assets are bundled, with no CDN or telemetry.

The example XDC is a tool-flow fixture for `xc7a35tcsg324-1`, **not a verified board template**. Verify every pin and configuration voltage against your actual board before programming it.

## Initial Release Limits

- Actual FPGA programming, Flash programming and board-specific electrical correctness require physical hardware verification.
- IP (`.xci`) and block designs (`.bd`) are listed and can be opened in the Vivado GUI; the automated build workflow rejects them in this release.
- VHDL, mixed-language simulation, custom compilation libraries, UVM and timing simulation are not implemented.
- Internal waveform preview is limited to 8 MiB, 2048 signals and 500000 changes; up to 64 matching signals are displayed at a time. Filter to view others. Larger traces remain available in WDB or an external VCD viewer.
- Internal schematic preview is limited to 1000 primitive cells, 2000 ports, 20000 pins and 6000 connections. Larger circuits should be inspected in Vivado GUI. Unsupported preview data does not invalidate a successful build or simulation.
- Independent syntax checks do not have precompiled project packages available. Package-heavy SystemVerilog projects may need on-type checking disabled and project elaboration used instead.
- On Windows, batch arguments containing literal double quotes, percent signs or line breaks are rejected explicitly. This includes quoted string-valued defines. Ordinary spaces and non-ASCII paths are tested separately.
- I/O Planning checks package-pin membership, duplicate use and basic I/O-standard compatibility. Full board-aware electrical validation, testbench generation, board templates and configuration Flash are not included.
- Source-based linting uses temporary files. Deactivation cancels active tools and normal completion removes snapshots; a forcibly terminated extension host may leave snapshots in the system temporary directory.

Vivado and Xilinx are trademarks of their respective owners. This is an independent local development project, not an AMD product.
