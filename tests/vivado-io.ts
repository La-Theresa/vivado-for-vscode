import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain } from '../src/toolchain/detect';
import { TclSession } from '../src/toolchain/tclSession';
import { resolveProject, writeConfig } from '../src/project/config';
import { buildProject } from '../src/build/builder';
import { parseSchematic } from '../src/build/schematic';
import { logicSymbol } from '../src/views/logicSymbols';
import { parseIoQuery, readIoPlan, saveIoPlan } from '../src/io/planner';
import { syncProjectTcl, tclList, tclString } from '../src/project/sync';

async function main() {
  const tools = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tools);
  await fs.mkdir(path.resolve('.test-work'), { recursive: true });
  const reuse = process.argv.find(arg => arg.startsWith('--reuse='))?.slice(8);
  const root = reuse ? path.resolve(reuse) : await fs.mkdtemp(path.resolve('.test-work/io-integration-'));
  assert.ok(path.dirname(root) === path.resolve('.test-work') && path.basename(root).startsWith('io-integration-'));
  if (!reuse) {
    await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: file => !file.includes('.vivado') });
    await fs.writeFile(path.join(root, 'rtl/top.v'), `module top(input clk, input [3:0] sw, output [3:0] led);
wire [3:0] comb;
assign comb[0] = sw[0] & sw[1];
assign comb[1] = sw[0] | sw[1];
assign comb[2] = sw[0] ^ sw[1];
assign comb[3] = ~sw[3];
sub u0(.clk(clk), .d(comb), .q(led));
endmodule
`);
  }
  const log: string[] = [];
  const record = (text: string) => { log.push(text); process.stdout.write(text); };
  const project = await resolveProject(root);
  if (!reuse) await buildProject(tools, project, 'synthesis', { cwd: root, jobs: 4, onOutput: record });
  const schematicFile = path.join(root, '.vivado/reports/schematic.xml');
  const schematic = parseSchematic(await fs.readFile(schematicFile, 'utf8'), schematicFile);
  for (const kind of ['and', 'or', 'xor', 'flipflop', 'buffer', 'ground', 'power']) assert.ok(schematic.nodes.some(node => logicSymbol(node).kind === kind), `Missing ${kind} symbol`);
  console.log('PASS real synthesized LUT truth tables map to distinctive gate symbols');
  const session = new TclSession(tools.vivado, root, 'utf8', record);
  try {
    let plan = await readIoPlan(project, tools, session);
    assert.equal(plan.part, project.config.part);
    assert.equal(plan.pins.length, 210);
    assert.ok(plan.ports.find(port => port.name === 'clk')?.packagePin);
    const port = plan.ports.find(port => port.name === 'led[0]')!;
    const bank = plan.pins.find(pin => pin.name === port.packagePin)!.bank;
    const replacement = plan.pins.find(pin => pin.bank === bank && !plan.ports.some(port => port.packagePin === pin.name))!;
    assert.ok(replacement);
    const entries = plan.ports.map(row => ({ ...row, packagePin: row.name === port.name ? replacement.name.toLowerCase() : row.packagePin }));
    const boardFile = path.join(root, 'constraints/pins.xdc'), board = await fs.readFile(boardFile, 'utf8');
    const target = path.join(root, 'constraints/planned-io.xdc');
    await assert.rejects(saveIoPlan(root, tools, plan, entries, boardFile), /preserve existing/);
    await assert.rejects(saveIoPlan(root, tools, plan, entries, path.resolve(root, '../outside.xdc')), /inside the workspace/);
    plan = await saveIoPlan(root, tools, plan, entries, target);
    assert.equal(await fs.readFile(boardFile, 'utf8'), board);
    assert.equal(plan.ports.find(row => row.name === port.name)?.packagePin, replacement.name);
    const savedProject = await resolveProject(root);
    plan = await readIoPlan(savedProject, tools, session);
    assert.equal(plan.ports.find(row => row.name === port.name)?.packagePin, replacement.name);
    console.log(`PASS XDC round trip: ${port.name} -> ${replacement.name}, 210 part-specific package pins`);
    const other = plan.ports.find(row => row.name === 'led[1]')!;
    const swapped = plan.ports.map(row => ({ ...row, packagePin: row.name === port.name ? other.packagePin : row.name === other.name ? replacement.name : row.packagePin }));
    plan = await saveIoPlan(root, tools, plan, swapped, target);
    plan = await readIoPlan(await resolveProject(root), tools, session);
    assert.equal(plan.ports.find(row => row.name === port.name)?.packagePin, other.packagePin);
    assert.equal(plan.ports.find(row => row.name === other.name)?.packagePin, replacement.name);
    console.log('PASS swapping two previously occupied pins');
    const beforeClear = plan.ports.map(row => ({ ...row }));
    plan = await saveIoPlan(root, tools, plan, plan.ports.map(row => row.name === port.name ? { ...row, packagePin: '', ioStandard: '' } : row), target);
    plan = await readIoPlan(await resolveProject(root), tools, session);
    assert.equal(plan.ports.find(row => row.name === port.name)?.packagePin, '');
    plan = await saveIoPlan(root, tools, plan, beforeClear, target);
    plan = await readIoPlan(await resolveProject(root), tools, session);
    assert.equal(plan.ports.find(row => row.name === port.name)?.packagePin, beforeClear.find(row => row.name === port.name)?.packagePin);
    assert.ok(!log.join('').includes('CRITICAL WARNING'), 'XDC round trip must not silently ignore unsupported commands.');
    console.log('PASS clearing an earlier pin assignment and restoring it');
    await session.execute(syncProjectTcl(savedProject));
    assert.equal(await session.execute(`get_property PROCESSING_ORDER [get_files ${tclList([target])}]`), 'LATE');
    await session.execute('close_project');
    await fs.appendFile(boardFile, '\n# concurrent edit\n');
    await assert.rejects(saveIoPlan(root, tools, plan, entries, target), /changed/);
    await fs.writeFile(boardFile, board);
    const changed = { ...savedProject.config, part: 'xc7a100tcsg324-1' };
    await writeConfig(root, changed);
    await assert.rejects(readIoPlan(await resolveProject(root), tools, session), /Run Synthesize/);
    await writeConfig(root, savedProject.config);
    console.log('PASS existing constraints preserved, concurrent edits and different parts rejected');
  } finally { await session.dispose(); }
  if (!process.argv.includes('--quick')) {
    const result = await buildProject(tools, await resolveProject(root), 'bitstream', { cwd: root, jobs: 4, onOutput: record });
    assert.ok(result.state.bitstream && (await fs.stat(result.state.bitstream)).size > 0);
    const expected = parseIoQuery(await fs.readFile(path.join(root, '.vivado/io/device.xml'), 'utf8'), project.config.part);
    const implemented = new TclSession(tools.vivado, root, 'utf8', record);
    try {
      await implemented.execute(`open_checkpoint ${tclString(path.join(project.projectDir, `${project.config.name}.runs/impl_1/${project.config.top}_routed.dcp`))}`, undefined, 90000);
      for (const port of expected.ports) {
        const pattern = '^' + port.name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '$';
        const target = `[get_ports -quiet -regexp ${tclString(pattern)}]`;
        assert.equal(await implemented.execute(`get_property PACKAGE_PIN ${target}`), port.packagePin, `${port.name} implemented package pin`);
        assert.equal(await implemented.execute(`get_property IOSTANDARD ${target}`), port.ioStandard, `${port.name} implemented I/O standard`);
      }
    } finally { await implemented.dispose(); }
    console.log('PASS routed checkpoint pins and I/O standards match all planned assignments');
    console.log(`PASS planned XDC synthesis/implementation/bitstream: ${result.state.bitstream}`);
  }
  await fs.writeFile(path.join(root, 'io-test-output.txt'), log.join(''), 'utf8');
  console.log(`ALL I/O TESTS PASSED: ${root}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
