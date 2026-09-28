import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain } from '../src/toolchain/detect';
import { requireSuccess } from '../src/toolchain/process';
import { parseMessages, pathKey } from '../src/toolchain/messageParser';
import { TclSession } from '../src/toolchain/tclSession';
import { installedParts } from '../src/project/parts';
import { resolveProject } from '../src/project/config';
import { importXpr } from '../src/project/importXpr';
import { createShadow } from '../src/lint/shadow';
import { compileFile, compileProject, elaborate, parallelMap } from '../src/lint/compiler';
import { buildProject } from '../src/build/builder';
import { simulate } from '../src/sim/simulator';
import { parseSchematic } from '../src/build/schematic';
import { readWaveform } from '../src/sim/waveform';
import { simulationRunTime } from '../src/sim/runtime';

async function main() {
  const tool = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tool, 'Vivado installation not found. Set VIVADO_PATH.');
  const base = path.resolve('.test-work');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'smoke-'));
  await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: source => !source.includes('.vivado') });
  const project = await resolveProject(root);
  const top = path.join(root, 'rtl/top.v');
  const original = await fs.readFile(top, 'utf8');
  const log: string[] = [];
  const record = (text: string) => { log.push(text); process.stdout.write(text); };
  console.log(`Testing Vivado ${tool.version} in ${root}`);
  const session = new TclSession(tool.vivado, root, 'utf8');
  try {
    console.log(`Tcl ${await session.execute('info patchlevel')}`);
    assert.equal(await session.execute('expr {2 + 3}'), '5');
    await assert.rejects(session.execute('error intentional'), /intentional/);
    assert.equal(await session.execute('set x "space and unicode \\u4e2d\\u6587"'), 'space and unicode \u4e2d\u6587');
    const parts = await installedParts(tool, path.join(root, '.vivado/cache'), session);
    assert.ok(parts.includes(project.config.part));
    console.log(`PASS Tcl queue and ${parts.length} installed devices`);
  } finally { await session.dispose(); }

  const dirty = await createShadow(root, [top], [], [{ file: top, text: 'module top;\n  invalid !!!;\nendmodule\n' }]);
  try {
    const results = await parallelMap([0, 1], 2, async index => compileFile(tool, { path: dirty.file(top), includeDirs: dirty.includes(top) }, { cwd: path.join(dirty.directory, `independent-${index}`) }));
    for (const result of results) {
      assert.notEqual(result.code, 0);
      assert.ok(parseMessages(result.output, root, dirty.original).some(message => message.file && pathKey(message.file) === pathKey(top)));
    }
    assert.equal(await fs.readFile(top, 'utf8'), original);
    console.log('PASS parallel dirty-file diagnostics map to original');
  } finally { await dirty.dispose(); }

  const shadow = await createShadow(root, project.files.sources, [], [{ file: top, text: original.replace('.d(sw)', '.missing(sw)') }]);
  try {
    const cwd = path.join(shadow.directory, 'cross');
    requireSuccess(await compileProject(tool, project.files.sources.map(file => ({ path: shadow.file(file), includeDirs: shadow.includes(file) })), { cwd }), 'Cross-module compile');
    const result = await elaborate(tool, project.config.top, { cwd });
    assert.notEqual(result.code, 0);
    assert.ok(parseMessages(result.output, cwd, shadow.original).some(message => message.file && pathKey(message.file) === pathKey(top) && message.line === 1));
    console.log('PASS cross-module port diagnostic at original line 2');
  } finally { await shadow.dispose(); }

  const sim = await simulate(tool, project, 'tb', { cwd: root, runTime: simulationRunTime(project.config), timescale: '1ns/1ps', onOutput: record });
  assert.ok(log.join('').includes('VIVADO_TEST_PASS'));
  assert.ok((await fs.stat(sim.wdb)).size > 0);
  assert.ok((await fs.stat(sim.vcd)).size > 0);
  const wave = await readWaveform(sim.vcd, path.resolve('dist/vivado_vcd_parser.wasm'));
  assert.equal(wave.unit, 'ps');
  assert.equal(wave.timescale, 1);
  // XSim emits the last recorded change at 25 ns, not the $finish time.
  assert.equal(wave.endTime, 25000);
  const clk = wave.signals.find(signal => signal.name === 'tb.clk')!;
  assert.ok(clk, 'The real XSim VCD must contain the testbench clock.');
  // $finish at 30 ns can precede the final clock assignment in that time slot.
  assert.deepEqual(clk.changes.filter(([time]) => time < 30000),
    [[0, '0'], [5000, '1'], [10000, '0'], [15000, '1'], [20000, '0'], [25000, '1']]);
  assert.deepEqual(wave.signals.find(signal => signal.name === 'tb.led')!.changes, [[0, 'xxxx'], [5000, '0011']]);
  console.log('PASS simulation and WDB/VCD');

  if (!process.argv.includes('--quick')) {
    const build = await buildProject(tool, project, 'bitstream', { cwd: root, jobs: 4, onOutput: record });
    assert.ok(build.state.bitstream && (await fs.stat(build.state.bitstream)).size > 0);
    const imported = importXpr(await fs.readFile(project.xpr, 'utf8'), project.xpr, root);
    assert.equal(imported.config.part, project.config.part);
    assert.equal(imported.config.top, 'top');
    assert.equal(imported.config.simulationRunTime, '1 us');
    const schematic = parseSchematic(await fs.readFile(path.join(root, '.vivado/reports/schematic.xml'), 'utf8'), 'schematic.xml');
    assert.ok(schematic.nodes.some(node => node.type === 'FDRE'));
    console.log(`PASS bitstream: ${build.state.bitstream}`);
  }
  await fs.writeFile(path.join(root, 'smoke-output.txt'), log.join(''), 'utf8');
  console.log(`ALL SMOKE TESTS PASSED: ${root}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
