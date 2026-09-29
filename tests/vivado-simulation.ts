import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain } from '../src/toolchain/detect';
import { CancelledError } from '../src/toolchain/process';
import { resolveProject, validateConfig, writeConfig } from '../src/project/config';
import { createProjectFile } from '../src/project/files';
import { clearSimulationCache, readSimulation, simulate } from '../src/sim/simulator';
import { readWaveform } from '../src/sim/waveform';

async function main() {
  const tools = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tools, 'Vivado installation not found. Set VIVADO_PATH.');
  const base = path.resolve('.test-work');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'simulation-'));
  await writeConfig(root, validateConfig({ version: 1, name: 'simulation_test', part: 'xc7a35tcsg324-1', top: 'top', sources: [] }));
  const source = await createProjectFile(root, 'sources', path.join(root, 'rtl/dut.v'), tools.version);
  const testbench = await createProjectFile(root, 'simulation', path.join(root, 'sim/tb_dut.sv'), tools.version);
  const project = await resolveProject(root);
  const options = { cwd: root, runTime: 'all', timescale: '1ns/1ps', timeoutMs: 60000, onOutput: (text: string) => process.stdout.write(text) };
  console.log(`Testing simulation lifecycle with Vivado ${tools.version} in ${root}`);
  await simulate(tools, project, 'tb_dut', options);
  console.log('PASS unmodified design/simulation templates compile and terminate');

  const design = (value: string) => `module dut(output wire [3:0] value); assign value = 4'h${value}; endmodule\n`;
  const bench = (period: number, finish = true) => '`timescale 1ns/1ps\nmodule tb_dut;\n'
    + `reg clk = 0; wire [3:0] value; dut instance_dut(value); always #${period} clk = ~clk;\n`
    + (finish ? 'initial begin #80; $finish; end\n' : 'initial begin #1; $display("CANCEL_READY"); end\n') + 'endmodule\n';
  await fs.writeFile(source, design('3'));
  await fs.writeFile(testbench, bench(5));
  const first = await simulate(tools, project, 'tb_dut', options);
  const firstWave = await readWaveform(first.vcd, path.resolve('dist/vivado_vcd_parser.wasm'));
  assert.deepEqual(firstWave.signals.find(signal => signal.name === 'tb_dut.clk')!.changes.slice(0, 3), [[0, '0'], [5000, '1'], [10000, '0']]);
  assert.deepEqual(firstWave.signals.find(signal => signal.name === 'tb_dut.value')!.changes, [[0, '0011']]);
  await fs.writeFile(source, design('A'));
  await fs.writeFile(testbench, bench(7));
  const second = await simulate(tools, project, 'tb_dut', options);
  const secondWave = await readWaveform(second.vcd, path.resolve('dist/vivado_vcd_parser.wasm'));
  assert.notEqual(first.directory, second.directory);
  assert.equal((await readSimulation(root)).directory, second.directory);
  assert.deepEqual(secondWave.signals.find(signal => signal.name === 'tb_dut.clk')!.changes.slice(0, 3), [[0, '0'], [7000, '1'], [14000, '0']]);
  assert.deepEqual(secondWave.signals.find(signal => signal.name === 'tb_dut.value')!.changes, [[0, '1010']]);
  console.log('PASS repeated simulation reflects both design and testbench edits');

  await fs.writeFile(source, 'module dut; invalid !!!; endmodule\n');
  await assert.rejects(simulate(tools, project, 'tb_dut', options), /compilation failed/);
  await assert.rejects(readSimulation(root), { code: 'ENOENT' });
  await fs.writeFile(source, design('A'));
  await simulate(tools, project, 'tb_dut', options);
  console.log('PASS compile failure invalidates old results and a corrected source reruns successfully');

  await fs.writeFile(testbench, bench(7, false));
  const controller = new AbortController();
  let output = '', reachedSimulation = false;
  const deadline = setTimeout(() => controller.abort(), 60000);
  try {
    await assert.rejects(simulate(tools, project, 'tb_dut', { ...options, signal: controller.signal, onOutput: text => {
      options.onOutput(text);
      output = (output + text).slice(-10000);
      if (output.includes('CANCEL_READY')) { reachedSimulation = true; controller.abort(); }
    } }), CancelledError);
  } finally { clearTimeout(deadline); }
  assert.ok(reachedSimulation, 'Cancel after XSim starts, not during compilation.');
  await assert.rejects(readSimulation(root), { code: 'ENOENT' });
  console.log('PASS cancellation terminates XSim and leaves no current waveform');

  await fs.mkdir(path.join(root, '.vivado/reports'), { recursive: true });
  const report = path.join(root, '.vivado/reports/keep.txt');
  await fs.writeFile(report, 'preserve build reports');
  await clearSimulationCache(root);
  await assert.rejects(fs.access(path.join(root, '.vivado/sim')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(report, 'utf8'), 'preserve build reports');
  await fs.access(source);
  await fs.writeFile(testbench, bench(11));
  const afterClear = await simulate(tools, await resolveProject(root), 'tb_dut', options);
  const clearedWave = await readWaveform(afterClear.vcd, path.resolve('dist/vivado_vcd_parser.wasm'));
  assert.deepEqual(clearedWave.signals.find(signal => signal.name === 'tb_dut.clk')!.changes.slice(0, 3), [[0, '0'], [11000, '1'], [22000, '0']]);
  console.log(`PASS cache clear and fresh simulation without reopening the project: ${root}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
