import fs from 'node:fs/promises';
import path from 'node:path';
import { ResolvedProject, discoverModules, isHdl, portablePath } from '../project/config';
import { tclString } from '../project/sync';
import { Toolchain } from '../toolchain/detect';
import { compileProject, compileFile, elaborate } from '../lint/compiler';
import { ProcessOptions, requireSuccess, runProcess } from '../toolchain/process';
import { ToolMessage, parseMessages } from '../toolchain/messageParser';
import { normalizeSimulationRunTime } from './runtime';

export interface SimulationState { directory: string; snapshot: string; wdb: string; vcd: string; top: string }

export function openWaveformTcl(wdb: string): string {
  return `open_wave_database ${tclString(portablePath(wdb))}\nadd_wave [get_objects -r /*]\n`;
}

export function simulationRunCommand(runTime: string): string {
  return `run ${normalizeSimulationRunTime(runTime)}`;
}

export async function simulationTops(project: ResolvedProject): Promise<string[]> {
  if (project.config.simulationTop) return [project.config.simulationTop];
  const modules = (await Promise.all(project.files.simulation.filter(isHdl).map(async file => discoverModules(await fs.readFile(file, 'utf8'))))).flat();
  const testbenches = modules.filter(name => /(^tb(?:_|$)|(?:_|^)tb$|testbench)/i.test(name));
  return [...new Set(testbenches.length ? testbenches : modules)];
}

export async function simulate(tools: Toolchain, project: ResolvedProject, top: string,
  options: ProcessOptions & { runTime: string; timescale: string; onMessages?: (messages: ToolMessage[]) => void }): Promise<SimulationState> {
  const run = simulationRunCommand(options.runTime);
  const simRoot = path.join(project.root, '.vivado', 'sim');
  await fs.mkdir(simRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(simRoot, 'run-'));
  const state = { directory, snapshot: 'vscode_sim', wdb: path.join(directory, 'wave.wdb'), vcd: path.join(directory, 'wave.vcd'), top };
  const files = [...new Set([...project.files.sources, ...project.files.simulation])].filter(isHdl);
  const opts = { ...options, cwd: directory, defines: project.config.defines };
  let log = '';
  const collect = (text: string) => { log = (log + text).slice(-8 * 1024 * 1024); options.onOutput?.(text); };
  try {
    requireSuccess(await compileProject(tools, files.map(file => ({ path: file, includeDirs: [path.dirname(file), ...project.includeDirs] })), { ...opts, onOutput: collect }), 'Simulation compilation');
    requireSuccess(await compileFile(tools, { path: tools.glbl, includeDirs: [] }, { ...opts, onOutput: collect }), 'glbl compilation');
    requireSuccess(await elaborate(tools, top, { ...opts, glbl: true, snapshot: state.snapshot, timescale: options.timescale, onOutput: collect }), 'Simulation elaboration');
    const script = path.join(directory, 'simulate.tcl');
    await fs.writeFile(script, `log_wave -r /\nopen_vcd ${tclString(portablePath(state.vcd))}\nlog_vcd [get_objects -r /*]\n${run}\nclose_vcd\nputs "@@VSCODE_SIM_DONE@@"\nquit\n`, 'utf8');
    const result = requireSuccess(await runProcess(tools.xsim, [state.snapshot, '--nolog', '--wdb', portablePath(state.wdb), '--tclbatch', portablePath(script), '--onerror', 'quit', '--onfinish', 'stop'], { ...opts, onOutput: collect }), 'Simulation');
    if (!/^@@VSCODE_SIM_DONE@@\s*$/m.test(result.output) || /^\s*(?:Fatal:|ERROR:)/m.test(result.output)) throw new Error('Simulation did not complete successfully. See Vivado Output.');
    await fs.access(state.wdb);
    await fs.access(state.vcd);
    await fs.writeFile(path.join(simRoot, 'last-run.json'), JSON.stringify(state, null, 2), 'utf8');
    return state;
  } finally { options.onMessages?.(parseMessages(log, directory)); }
}

export async function readSimulation(root: string): Promise<SimulationState> {
  return JSON.parse(await fs.readFile(path.join(root, '.vivado', 'sim', 'last-run.json'), 'utf8'));
}
