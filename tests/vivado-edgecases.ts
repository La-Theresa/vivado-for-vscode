import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain } from '../src/toolchain/detect';
import { compileFile, compileProject, elaborate } from '../src/lint/compiler';
import { runProcess, requireSuccess } from '../src/toolchain/process';
import { portablePath, resolveProject } from '../src/project/config';
import { buildProject, readBuildState, runBatch } from '../src/build/builder';
import { openWaveformTcl } from '../src/sim/simulator';
import { ToolMessage } from '../src/toolchain/messageParser';
import { TclSession } from '../src/toolchain/tclSession';
import { hardwareTargets, NoHardwareError } from '../src/hw/hardware';

async function main() {
  const tools = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tools);
  const base = path.resolve('.test-work');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'edge-'));
  await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: source => !source.includes('.vivado') });
  const project = await resolveProject(root);
  for (const name of ['space directory', '\u4e2d\u6587 directory']) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    const file = path.join(directory, 'test.v');
    await fs.writeFile(file, 'module test; endmodule\n');
    const result = await compileFile(tools, { path: file, includeDirs: [directory] }, { cwd: path.join(root, 'path-check') });
    console.log(`PATH ${JSON.stringify(name)} exit=${result.code}`);
    if (result.code !== 0) console.log(result.output);
    if (name === 'space directory') requireSuccess(result, 'Space path');
  }
  const cwd = path.join(root, 'options-check');
  requireSuccess(await compileProject(tools, [...project.files.sources, ...project.files.simulation].map(file => ({ path: file, includeDirs: [] })), { cwd }), 'Compile options fixture');
  let start = Date.now();
  requireSuccess(await elaborate(tools, 'tb', { cwd }), 'mt off with timescale');
  console.log(`MT off + timescale: ${Date.now() - start} ms`);
  start = Date.now();
  const automatic = await runProcess(tools.xelab, ['--nolog', '--mt', 'auto', '--timescale', '1ns/1ps', 'xil_defaultlib.tb', '-s', 'auto_check'], { cwd });
  console.log(`MT auto + timescale: ${Date.now() - start} ms, exit=${automatic.code}`);
  const relax = await runProcess(tools.xelab, ['--nolog', '--mt', 'off', '--relax', 'xil_defaultlib.tb', '-s', 'relax_check'], { cwd });
  console.log(`RELAX without explicit timescale: exit=${relax.code}`);
  if (relax.code) console.log(relax.output);

  if (process.argv.includes('--negative-build')) {
    const constraints = path.join(root, 'constraints/pins.xdc');
    const original = await fs.readFile(constraints, 'utf8');
    await fs.writeFile(constraints, original + '\nset_property PACKAGE_PIN NOT_A_PIN [get_ports clk]\nset_property IOSTANDARD LVCMOS18 [get_ports {sw[0]}]\n');
    let messages: ToolMessage[] = [];
    await assert.rejects(buildProject(tools, project, 'implementation', { cwd: root, jobs: 4,
      onOutput: text => { if (/ERROR:|@@VSCODE/.test(text)) process.stdout.write(text); }, onMessages: value => { messages = value; } }));
    console.log('NEGATIVE BUILD MESSAGES', JSON.stringify(messages.filter(m => m.severity === 'error')));
    assert.ok(messages.some(m => m.severity === 'error'));
    assert.ok(messages.some(m => m.file?.endsWith('pins.xdc') && m.line === 12));
    assert.equal(await readBuildState(root), undefined);
    await fs.writeFile(constraints, original);
    await buildProject(tools, project, 'synthesis', { cwd: root, jobs: 4, onMessages: value => { messages = value; } });
    assert.equal(messages.some(m => m.severity === 'error'), false, 'Old implementation errors must not survive a corrected synthesis.');
    console.log('PASS failed build invalidates state and corrected project rebuilds');
  }
  if (process.argv.includes('--hardware')) {
    const session = new TclSession(tools.vivado, root);
    try {
      assert.equal(await session.execute('set x "\u4e2d\u6587"'), '\u4e2d\u6587');
      try { console.log('HARDWARE TARGETS', await hardwareTargets(session, 'localhost:3121')); }
      catch (error) { assert.ok(error instanceof NoHardwareError); console.log('PASS no-board error:', error.message); }
    } finally { await session.dispose(); }
  }
  const previous = process.argv.find(arg => arg.startsWith('--wave='))?.slice(7);
  if (previous) {
    const script = path.join(root, 'inspect-wave.tcl');
    const result = await runBatch(tools, openWaveformTcl(previous) + '\nputs "@@WAVE_OPENED@@"', script, { cwd: path.dirname(previous), timeoutMs: 30000 });
    console.log('STATIC WDB OPEN', result.code, result.output);
    assert.match(result.output, /^@@WAVE_OPENED@@\s*$/m);
  }
  console.log(`EDGE CASE TESTS COMPLETED: ${root}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
