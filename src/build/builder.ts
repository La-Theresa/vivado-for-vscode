import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fg from 'fast-glob';
import { PROJECT_IGNORES, ResolvedProject, portablePath } from '../project/config';
import iconv from 'iconv-lite';
import { guardedTcl, syncProjectTcl, tclString } from '../project/sync';
import { Toolchain } from '../toolchain/detect';
import { ProcessOptions, ProcessResult, requireSuccess, runProcess } from '../toolchain/process';
import { parseMessages, ToolMessage } from '../toolchain/messageParser';
import { schematicTcl } from './schematic';

export type BuildStage = 'synthesis' | 'implementation' | 'bitstream';
export interface BuildState { fingerprint: string; designFingerprint?: string; stage: BuildStage; bitstream?: string; completedAt: string }
export interface BuildResult { messages: ToolMessage[]; state: BuildState }

export async function projectFingerprint(project: ResolvedProject, tools: Toolchain): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(project.config)).update(tools.root + tools.version);
  const headers = await fg('**/*.{vh,svh}', { cwd: project.root, absolute: true, ignore: PROJECT_IGNORES });
  for (const directory of project.includeDirs) headers.push(...await fg('**/*.{vh,svh}', { cwd: directory, absolute: true }));
  for (const file of [...new Set([...Object.values(project.files).flat(), ...headers])].sort()) hash.update(file).update(await fs.readFile(file));
  return hash.digest('hex');
}

export async function designFingerprint(project: ResolvedProject, tools: Toolchain): Promise<string> {
  const { part, top, name, defines } = project.config;
  const hash = createHash('sha256').update(JSON.stringify({ part, top, name, defines, includeDirs: project.includeDirs })).update(tools.root + tools.version);
  const headers = await fg('**/*.{vh,svh}', { cwd: project.root, absolute: true, ignore: PROJECT_IGNORES });
  for (const directory of project.includeDirs) headers.push(...await fg('**/*.{vh,svh}', { cwd: directory, absolute: true }));
  for (const file of [...new Set([...project.files.sources, ...headers])].sort()) hash.update(file).update(await fs.readFile(file));
  return hash.digest('hex');
}

export async function readBuildState(root: string): Promise<BuildState | undefined> {
  return fs.readFile(path.join(root, '.vivado', 'build-state.json'), 'utf8').then(JSON.parse).catch(() => undefined);
}

export async function runBatch(tools: Toolchain, script: string, filename: string, options: ProcessOptions): Promise<ProcessResult> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, guardedTcl(script), 'utf8');
  return runProcess(tools.vivado, ['-mode', 'batch', '-nolog', '-nojournal', '-notrace', '-source', portablePath(filename)], options);
}

export function buildTcl(project: ResolvedProject, stage: BuildStage, jobs: number, resetSynth: boolean): string {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('Build jobs must be between 1 and 64.');
  const reports = path.join(project.root, '.vivado', 'reports');
  return syncProjectTcl(project) + `
proc vscode_run {name step jobs} {
  puts "@@VSCODE_PROGRESS:$name:0@@"
  if {$step eq ""} { launch_runs $name -jobs $jobs } else { launch_runs $name -to_step $step -jobs $jobs }
  wait_on_run $name
  set run [get_runs $name]
  set status [get_property STATUS $run]
  if {[get_property PROGRESS $run] ne "100%" || ![string match "*Complete*" $status]} { error "$name failed: $status" }
  puts "@@VSCODE_PROGRESS:$name:100@@"
}
set synth [get_runs synth_1]
if {${resetSynth ? '1' : '0'} || [get_property NEEDS_REFRESH $synth] || [get_property PROGRESS $synth] ne "100%"} {
  reset_run synth_1
  vscode_run synth_1 "" ${jobs}
}
file mkdir ${tclString(reports)}
open_run synth_1
if {[catch {
${schematicTcl(path.join(reports, 'schematic.xml'))}
} schematic_error]} {
  file delete -force ${tclString(path.join(reports, 'schematic.xml'))}
  puts "WARNING: \\[VSCODE PREVIEW\\] Schematic export failed: $schematic_error"
}
${stage !== 'synthesis' ? `
close_design
reset_run impl_1
vscode_run impl_1 ${stage === 'bitstream' ? 'write_bitstream' : 'route_design'} ${jobs}
open_run impl_1
` : ''}
file mkdir ${tclString(reports)}
report_utilization -file ${tclString(path.join(reports, 'utilization.rpt'))}
report_timing_summary -file ${tclString(path.join(reports, 'timing.rpt'))}
report_drc -file ${tclString(path.join(reports, 'drc.rpt'))}
set metrics [open ${tclString(path.join(reports, 'metrics.tsv'))} w]
set r [get_runs ${stage === 'synthesis' ? 'synth_1' : 'impl_1'}]
foreach prop {STATS.WNS STATS.TNS STATS.WHS STATS.THS} {
  if {![catch {get_property $prop $r} value]} { puts $metrics "$prop\t$value" }
}
close $metrics
close_project
`;
}

export async function buildProject(tools: Toolchain, project: ResolvedProject, stage: BuildStage,
  options: ProcessOptions & { jobs: number; onMessages?: (messages: ToolMessage[]) => void; rebuild?: boolean }): Promise<BuildResult> {
  if (!project.files.sources.length) throw new Error('No design sources match this project.');
  if (project.files.sources.some(file => /\.(xci|bd)$/i.test(file))) throw new Error('IP/block designs are not supported by this build workflow yet. Open the project in Vivado GUI.');
  const fingerprint = await projectFingerprint(project, tools);
  const design = await designFingerprint(project, tools);
  const previous = await readBuildState(project.root);
  const reset = options.rebuild || stage === 'synthesis' || previous?.fingerprint !== fingerprint;
  const stateFile = path.join(project.root, '.vivado', 'build-state.json');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  // A failed or cancelled run must not expose a previous bitstream as current.
  await fs.rm(stateFile, { force: true });
  let result: ProcessResult | undefined;
  let streamed = '', markerTail = '';
  const launched = new Set<string>();
  try {
    result = await runBatch(tools, buildTcl(project, stage, options.jobs, reset), path.join(project.root, '.vivado', 'scripts', 'build.tcl'), {
      ...options, cwd: project.root, onOutput: text => {
        streamed = (streamed + text).slice(-8 * 1024 * 1024);
        markerTail += text;
        for (const match of markerTail.matchAll(/@@VSCODE_PROGRESS:([^:]+):0@@/g)) launched.add(match[1]);
        markerTail = markerTail.slice(-256);
        options.onOutput?.(text);
      },
    });
  } finally {
    let output = result?.output || streamed;
    const logs = await fg('**/runme.log', { cwd: project.projectDir, absolute: true });
    for (const log of logs) {
      const run = path.basename(path.dirname(log));
      if (!launched.has(run) && !(run === 'synth_1' && !reset)) continue;
      output += '\n' + await fs.readFile(log).then(buffer => iconv.decode(buffer, options.encoding || 'utf8')).catch(() => '');
    }
    options.onMessages?.(parseMessages(output, project.root));
  }
  requireSuccess(result!, 'Vivado build');
  const state: BuildState = { fingerprint, designFingerprint: design, stage, completedAt: new Date().toISOString() };
  if (stage === 'bitstream') {
    const bitstream = path.join(project.projectDir, `${project.config.name}.runs`, 'impl_1', `${project.config.top}.bit`);
    await fs.access(bitstream);
    state.bitstream = bitstream;
  }
  if (await projectFingerprint(project, tools) !== fingerprint) throw new Error('Project files changed during the build. Build again before programming.');
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  return { state, messages: parseMessages(result!.output, project.root) };
}
