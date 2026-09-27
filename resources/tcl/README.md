# Tcl Generation

The tested Tcl generators are `src/project/sync.ts`, `src/build/builder.ts`,
`src/sim/simulator.ts`, and `src/hw/hardware.ts`. They use Tcl 8.5-compatible
commands and escape every substituted path and value through `tclString` or
`tclList`. Generated, inspectable batch scripts are stored in the project's
`.vivado/scripts` directory; simulation scripts live in their run directory.

No duplicate Tcl templates are maintained here. The generators are exercised by
unit tests and the real Vivado smoke test so that quoting, reset behavior and
error handling cannot drift between a template and an implementation.
