import path from 'node:path';
import { ResolvedProject } from './config';
import { DEFAULT_SIMULATION_RUN_TIME } from '../sim/runtime';

export function tclString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}
export const tclList = (values: string[]) => `[list ${values.map(tclString).join(' ')}]`;

export function syncProjectTcl(project: ResolvedProject): string {
  const { config, files } = project;
  return `
if {[file exists ${tclString(project.xpr)}]} {
  open_project ${tclString(project.xpr)}
} else {
  create_project ${tclString(config.name)} ${tclString(project.projectDir)} -part ${tclString(config.part)}
}
set_property part ${tclString(config.part)} [current_project]
proc vscode_sync_files {fileset wanted} {
  set normalized {}
  foreach f $wanted { lappend normalized [file normalize $f] }
  set wanted $normalized
  foreach existing [get_files -quiet -of_objects [get_filesets $fileset]] {
    if {[lsearch -exact $wanted [file normalize $existing]] < 0} {
      remove_files -fileset $fileset $existing
    }
  }
  set current {}
  foreach f [get_files -quiet -of_objects [get_filesets $fileset]] { lappend current [file normalize $f] }
  foreach f $wanted {
    if {[lsearch -exact $current $f] < 0} { add_files -fileset $fileset -norecurse $f }
  }
}
vscode_sync_files sources_1 ${tclList(files.sources)}
vscode_sync_files constrs_1 ${tclList(files.constraints)}
${config.ioConstraints ? `set vscode_io_file [get_files -quiet ${tclList([path.resolve(project.root, config.ioConstraints)])}]
set_property PROCESSING_ORDER LATE $vscode_io_file
reorder_files -fileset constrs_1 -back $vscode_io_file` : ''}
vscode_sync_files sim_1 ${tclList(files.simulation)}
set_property top ${tclString(config.top)} [get_filesets sources_1]
${config.simulationTop ? `set_property top ${tclString(config.simulationTop)} [get_filesets sim_1]` : ''}
set_property xsim.simulate.runtime ${tclString(config.simulationRunTime ?? DEFAULT_SIMULATION_RUN_TIME)} [get_filesets sim_1]
foreach fileset {sources_1 sim_1} {
  set_property include_dirs ${tclList(project.includeDirs)} [get_filesets $fileset]
  set_property verilog_define ${tclList(config.defines)} [get_filesets $fileset]
}
update_compile_order -fileset sources_1
update_compile_order -fileset sim_1
`;
}

export function guardedTcl(body: string): string {
  return `if {[catch {\n${body}\n} vscode_error vscode_options]} {
  puts stderr "ERROR: \\[VSCODE 1\\] $vscode_error"
  if {[dict exists $vscode_options -errorinfo]} { puts stderr [dict get $vscode_options -errorinfo] }
  exit 1
}
exit 0
`;
}
