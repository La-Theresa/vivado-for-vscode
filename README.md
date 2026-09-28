# Vivado for VS Code

English | [简体中文](README.zh-CN.md)

A local-first VS Code extension for Verilog/SystemVerilog development with an installed Vivado toolchain. The initial compatibility target is Windows and Vivado 2018.3. Language highlighting is provided by `mshr-h.veriloghdl`; this extension does not register competing language IDs.

Manage projects, inspect diagnostics, synthesize and implement designs, simulate with waveform previews, inspect synthesized schematics, plan I/O assignments, and program a connected FPGA without leaving the editor.

**Preview status:** version `0.4.1` is intended for local evaluation. It has not been fully debugged and is not recommended for industrial use. Development progress may depend on the author's course schedule; see SUSTech's digital logic course labs for reference.

## Contents

- [Vivado for VS Code](#vivado-for-vs-code)
  - [Contents](#contents)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Quick Start](#quick-start)
  - [Project Configuration](#project-configuration)
  - [Workflows](#workflows)
  - [I/O Planning](#io-planning)
  - [Settings](#settings)
  - [Security and Privacy](#security-and-privacy)
  - [Troubleshooting](#troubleshooting)
  - [Initial Release Limits](#initial-release-limits)
  - [License](#license)

## Requirements

- Desktop VS Code `1.90.0` or later, as declared in the extension manifest.
- An independently installed Vivado toolchain with `vivado`, `xvlog`, `xelab`, `xsim`, and the required device support. Vivado is not included in the extension.
- A local filesystem workspace that you trust. Browser-only and virtual workspaces are not supported.
- Windows with Vivado 2018.3 is the initial tested configuration. Linux and other Vivado versions have not been qualified; macOS is not a supported toolchain host.
- For programming: a compatible connected board, cable drivers, and a reachable `hw_server`.
- For building this extension from source only: Node.js 22 or later, npm, and Rust 1.85.1 with `rust-src` and `wasm32-unknown-unknown`. Installing the VSIX does not require Rust.

## Installation

To evaluate the extension locally, build a VSIX from this repository. Install the pinned Rust toolchain as described in the [WASM build instructions](wasm/README.md) first:

```sh
npm ci
npm run check
npm test
npm run package
```

In VS Code, run **Extensions: Install from VSIX...** and select `vivado-for-vscode-0.4.1.vsix`, or run:

```sh
code --install-extension ./vivado-for-vscode-0.4.1.vsix
```

`mshr-h.veriloghdl` is a required dependency for Verilog, SystemVerilog and XDC highlighting. Install and enable it before using this extension; offline installations need its VSIX too. After upgrading, run **Developer: Reload Window**. This project does not ship that extension's code or the Vivado installer.

For a self-contained example, open [`examples/counter`](examples/counter) from the source checkout as the workspace folder, not the repository root. Examples and development/test artifacts are intentionally excluded from the VSIX.

The example XDC is a tool-flow fixture for `xc7a35tcsg324-1`, **not a verified board template**. Verify every pin and configuration voltage against your actual board before programming it.

## Quick Start

1. Install the generated VSIX using **Extensions: Install from VSIX**.
2. Open a local, trusted workspace folder.
3. Set `vivado.installPath` to your Vivado version directory, for example `C:/Xilinx/Vivado/2018.3`. Otherwise detection checks `XILINX_VIVADO`, PATH and common installation directories.
4. Run **Vivado: New Project**, enter a name, select a parent location, and choose an installed part and top module. A new subfolder is created without overwriting existing folders. Alternatively, use **Vivado: Import XPR Project** or **Vivado: Open Project** to select an existing `vivado-project.json`.
5. Add files from Explorer or the Vivado sidebar. Set the design top or simulation top from a source file's context menu.
6. Use the play button at the top right of an HDL editor to run simulation. The adjacent menu includes synthesis, implementation, bitstream generation and previews. During a run, the play button becomes Stop.

The status bar shows the detected Vivado version. Diagnostics appear in Problems, tool output appears in the Vivado Output channel, and simulation output also appears in a terminal. Build notifications and the status bar offer cancellation.

**Vivado: Close Project** is available in the project context menu, sidebar menu and Run menu. It stops that project's tasks, closes its Tcl Console and previews, and clears its diagnostics without deleting files or closing unsaved source editors. Unsaved I/O table edits are discarded after confirmation. The project stays closed across refresh/reload; use **Open Project** to reopen it. Nested projects and imported external sources are recognized independently of the workspace root.

To avoid duplicate lint results from the highlighting extension, set `verilog.linting.linter` to `none` yourself. This extension does not change another extension's settings.

## Project Configuration

Each project folder contains `vivado-project.json`; paths are relative to that folder:

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

Paths are relative to the folder containing `vivado-project.json`; absolute paths and external file references are accepted. Patterns are expanded in their declared order, with deterministic ordering inside each pattern and duplicate removal. Put SystemVerilog packages before their users. Include memory/data files in `sources` when they are build inputs, so their content participates in stale-build detection.

New and imported projects explicitly include `"simulationRunTime": "1 us"`. For existing projects, this field is optional: the priority is **project `simulationRunTime` > VS Code `vivado.sim.runTime` > `1 us`**. Use `"all"` only when the testbench ends itself (for example with `$finish`) or you intend to cancel it. The selected duration and its source are printed before each simulation. Changes apply to the next run, not an already running simulator.

New projects use `"projectDirectory": "."` and the native Vivado layout:

```text
<selected location>/my_project/
  vivado-project.json
  my_project.xpr
  my_project.srcs/
    sources_1/new/
    constrs_1/new/
    sim_1/new/
  .vivado/
```

Vivado creates its `.runs`, `.cache` and other native output directories as needed. New source patterns point to the corresponding `.srcs` filesets. The generated-project directory is configurable through `projectDirectory`, a relative path inside the project folder. Existing/imported configurations without this field continue to use `.vivado/project`; no existing files are moved.

Extension scripts, reports and simulations remain under `.vivado/scripts`, `.vivado/reports` and `.vivado/sim`. Ignore `.vivado/` and generated Vivado output directories in your project's version control, but keep `.srcs` source files. Removing a file from the sidebar changes configuration and exclusions only; it never deletes the source file. Add a removed file again to remove its exact exclusion.

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
- **Tcl Console:** **Vivado: Open Tcl Console** opens a real interactive Vivado terminal with the synchronized XPR loaded. It is available from the sidebar terminal icon, project context menu and Run menu; repeated calls focus the same terminal. Commands such as `get_files` and `get_property PART [current_project]` run directly in Vivado. This is separate from the read-only Output channel and simulation terminal. Before automated operations, the extension asks to close the console to release the project. Keep durable project settings in `vivado-project.json`; automatic synchronization can replace manual Tcl changes. Use **Close Tcl Console** to release it without closing the project.

Build, simulation and programming commands ask before saving modified workspace files. Syntax checks never save your files. Workspace trust is required because HDL tools and project constraints can execute code.

## I/O Planning

1. Run **Vivado: Synthesize**. After upgrading from version 0.2, synthesize once again to export symbol properties and establish a current design snapshot.
2. Open **Vivado: I/O Planning**, or click a top-level schematic port to select its row.
3. Enter a **Package Pin** manually, or click the row's list icon. The picker searches actual package pins by name/function, filters by bank, and marks occupied pins. Reserved/power pins are excluded. The table shows direction, bank, pin function and an I/O-standard selector.
4. Choose the I/O standard appropriate for your board. Invalid pins, duplicate assignments and standards unsupported by the bank/direction block saving. Incomplete assignments and mixed nominal bank voltages are warnings.
5. Click **Save Constraints** and choose a new `.xdc` inside the project folder, for example `constraints/io-planning.xdc`. The extension automatically records `"ioConstraints": "constraints/io-planning.xdc"` in `vivado-project.json`. Do not add this field until the file exists.
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

## Security and Privacy

- Workspace Trust is required. Vivado, HDL and XDC/Tcl inputs can execute code with your account's permissions; this extension is not a sandbox. Review unfamiliar projects before trusting them.
- Project configuration permits absolute paths and references outside the workspace. Review imported paths before running tools.
- This extension adds no telemetry or cloud upload, and its preview scripts, styles and parser are bundled locally. Vivado/licensing services, VS Code and companion extensions have their own network behavior. Hardware programming connects to the configured `hw_server`.
- Source snapshots, reports and simulator traces can contain proprietary design data and local paths. Keep `.vivado/`, generated traces, credentials and local settings out of public repositories. Abnormal termination can leave source snapshots in the system temporary directory.
- Device programming requires explicit confirmation. The sample pin constraints are not a board-safety guarantee.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Vivado is not found | Select the version directory, not an executable. All four command-line tools must exist. A configured invalid path deliberately does not fall back to another installation. |
| No highlighting | Install/enable the required `mshr-h.veriloghdl` extension and reload the window. Check the editor language mode and custom `files.associations`. |
| No project actions in the editor | Open the project's `vivado-project.json` with **Vivado: Open Project**, trust the workspace, and run **Vivado: Refresh Project**. Closed projects intentionally have no Run actions. |
| Cannot type Tcl commands | Use **Vivado: Open Tcl Console**, not Output or the simulation output terminal. |
| Duplicate diagnostics | Set the companion extension's `verilog.linting.linter` to `none`. |
| Garbled Chinese tool output | Set `vivado.outputEncoding` to `gbk`, then retry the operation. |
| Simulation never ends | Use a finite `simulationRunTime`, or ensure an `all` testbench calls `$finish`. Cancel from the Run menu if needed. |
| Schematic/I/O view is stale | Save sources and run **Vivado: Synthesize**; reload the I/O view before editing. |
| Project is locked or modified unexpectedly | Close the native Vivado GUI project before using VS Code build commands. |
| No hardware target | Check board power, cable drivers, the server URL and connectivity; a successful build alone cannot validate the board. |

When reporting a problem, include the extension, VS Code, OS and Vivado versions, a minimal project, and sanitized excerpts from **Output > Vivado**. Do not post tokens, proprietary HDL, board serial numbers, or unredacted absolute paths. See the repository's [issue tracker](https://github.com/La-Theresa/vivado-for-vscode/issues).

## Initial Release Limits

- Actual FPGA programming, Flash programming and board-specific electrical correctness require physical hardware verification.
- IP (`.xci`) and block designs (`.bd`) are listed and can be opened in the Vivado GUI; the automated build workflow rejects them in this release.
- VHDL, mixed-language simulation, custom compilation libraries, UVM and timing simulation are not implemented.
- Internal waveform preview is limited to 8 MiB input, 2048 signals, 4096 bits per signal, 64 hierarchy levels, 500000 changes and a 32 MiB expanded-timeline budget. Timestamps must fit JavaScript's exact integer range. Up to 64 matching signals are displayed at a time; filter to view others. Larger traces remain available in WDB or an external VCD viewer.
- Internal schematic preview is limited to 1000 primitive cells, 2000 ports, 20000 pins and 6000 connections. Larger circuits should be inspected in Vivado GUI. Unsupported preview data does not invalidate a successful build or simulation.
- Independent syntax checks do not have precompiled project packages available. Package-heavy SystemVerilog projects may need on-type checking disabled and project elaboration used instead.
- On Windows, batch arguments containing literal double quotes, percent signs or line breaks are rejected explicitly. This includes quoted string-valued defines. Ordinary spaces and non-ASCII paths are tested separately.
- I/O Planning checks package-pin membership, duplicate use and basic I/O-standard compatibility. Full board-aware electrical validation, testbench generation, board templates and configuration Flash are not included.
- Source-based linting uses temporary files. Deactivation cancels active tools and normal completion removes snapshots; a forcibly terminated extension host may leave snapshots in the system temporary directory.

## License

This project's source is licensed under [MIT](LICENSE). Bundled third-party components retain their own licenses; the build generates `dist/THIRD_PARTY_NOTICES.md`. The VCD parser is built from project-owned Rust source and locked dependencies, with preserved upstream license texts and a binary/source hash receipt. It no longer uses the precompiled `rust_vcd_wasm` package. See [third_party/README.md](third_party/README.md) for provenance and notice coverage. Vivado itself is neither included nor relicensed by this project.

Vivado and Xilinx are trademarks of their respective owners. This is an independent community project, not an AMD product and not affiliated with or endorsed by AMD.
