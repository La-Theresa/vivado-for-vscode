import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseIoQuery, ioConstraintsTcl } from '../src/io/planner';
import { validateIoAssignments } from '../src/io/validation';
import { CircuitNode, IoData } from '../src/views/previewModel';
import { logicSymbol } from '../src/views/logicSymbols';
import { layoutCircuit } from '../src/views/circuitLayout';
import { designFingerprint, projectFingerprint } from '../src/build/builder';
import { resolveProject, validateConfig, writeConfig } from '../src/project/config';
import { Toolchain } from '../src/toolchain/detect';
import { syncProjectTcl } from '../src/project/sync';

const xml = `<io part="xc7a35tcsg324-1">
<pin name="A1" bank="14" function="IO_L1P" clock="1" mate="A2"/>
<pin name="A2" bank="14" function="IO_L1N" clock="0" mate="A1"/>
<pin name="B1" bank="15" function="IO_0" clock="0" mate=""/>
<bank name="14" type="BT_HIGH_RANGE" standards="LVCMOS18 LVCMOS33"/>
<bank name="15" type="BT_HIGH_PERFORMANCE" standards="LVCMOS18"/>
<standard name="LVCMOS18" directions="INPUT OUTPUT BIDIR" vccoIn="1.8" vccoOut="1.8"/>
<standard name="LVCMOS33" directions="INPUT OUTPUT BIDIR" vccoIn="3.3" vccoOut="3.3"/>
<port name="clk" direction="IN" pin="A1" standard="LVCMOS18"/>
<port name="led[0]" direction="OUT" pin="" standard="DEFAULT"/>
</io>`;
const part = 'xc7a35tcsg324-1';
const snapshot = (): IoData => ({ kind: 'ioPlanning', title: 'top', source: 'test.dcp', part, generatedAt: '', revision: 'test', constraintFile: 'constraints/io.xdc', ...parseIoQuery(xml, part) });

test('I/O query preserves device, banks, directions and unassigned ports', () => {
  const data = snapshot();
  assert.equal(data.pins.length, 3);
  assert.equal(data.pins[0].clock, true);
  assert.equal(data.pins[0].differentialMate, 'A2');
  assert.equal(data.ports[1].name, 'led[0]');
  assert.equal(data.ports[1].ioStandard, '');
  assert.throws(() => parseIoQuery(xml, 'xc7a100t'), /match/);
  assert.throws(() => parseIoQuery('<!DOCTYPE io>' + xml, part), /Invalid/);
  assert.throws(() => parseIoQuery(xml.replace('name="A2" bank', 'name="A1" bank'), part), /Duplicate/);
});

test('I/O assignments reject duplicate, reserved, mismatched bank and unknown port choices', () => {
  const data = snapshot();
  const entries = [{ name: 'clk', packagePin: ' a1 ', ioStandard: 'lvcmos18' }, { name: 'led[0]', packagePin: 'A2', ioStandard: 'LVCMOS18' }];
  const valid = validateIoAssignments(data, entries);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.assignments[0].packagePin, 'A1');
  assert.deepEqual(valid.warnings, []);
  assert.match(validateIoAssignments(data, [entries[0], { ...entries[1], packagePin: 'A1' }]).errors.join(), /both/);
  assert.match(validateIoAssignments(data, [entries[0], { ...entries[1], packagePin: 'GND' }]).errors.join(), /not a bonded/);
  assert.match(validateIoAssignments(data, [entries[0], { ...entries[1], packagePin: 'B1', ioStandard: 'LVCMOS33' }]).errors.join(), /bank 15/);
  assert.match(validateIoAssignments(data, [entries[0], { ...entries[1], name: 'missing' }]).errors.join(), /Unknown/);
  assert.match(validateIoAssignments(data, []).errors.join(), /port list/);
  assert.match(validateIoAssignments(data, [entries[0], { ...entries[1], ioStandard: 'LVCMOS33' }]).warnings.join(), /mixed nominal VCCO/);
  assert.match(validateIoAssignments(data, data.ports).warnings.join(), /no package pin/);
});

test('XDC generator uses exact port matching, explicit clears and Tcl escaping', () => {
  const output = ioConstraintsTcl(snapshot(), snapshot().ports);
  assert.match(output, /set_property PACKAGE_PIN "A1"/);
  assert.match(output, /set_property PACKAGE_PIN \{\}/);
  assert.match(output, /set_property IOSTANDARD \{\}/);
  assert.doesNotMatch(output, /reset_property/);
  assert.equal((output.match(/set_property IOSTANDARD \{\}/g) || []).length, 1);
  assert.match(output, /-regexp/);
  assert.ok(output.includes('^led\\\\\\[0\\\\\\]\\$'));
  const special = ioConstraintsTcl(snapshot(), [{ name: 'escaped];$name"{}', packagePin: 'A1', ioStandard: 'LVCMOS18' }]);
  assert.ok(special.includes('\\$name'));
  assert.ok(special.includes('\\"'));
});

function lut(width: number, init: string): CircuitNode {
  return { id: 'lut', name: 'gate', type: `LUT${width}`, port: false, pins: [], properties: { INIT: init } };
}
test('ANSI distinctive gates are derived from exact LUT truth tables', () => {
  const fixtures = [['8', 'and', false], ['7', 'and', true], ['E', 'or', false], ['1', 'or', true], ['6', 'xor', false], ['9', 'xor', true]] as const;
  for (const [hex, kind, inverted] of fixtures) {
    const result = logicSymbol(lut(2, `4'h${hex}`));
    assert.equal(result.kind, kind);
    assert.equal(!!result.inverted, inverted);
  }
  assert.equal(logicSymbol(lut(1, "2'h1")).inverted, true);
  assert.equal(logicSymbol(lut(1, "2'h2")).kind, 'buffer');
  assert.deepEqual(logicSymbol(lut(2, "4'h2")), { kind: 'and', invertedInputs: ['I1'] });
  assert.equal(logicSymbol(lut(3, "8'h96")).kind, 'xor');
  assert.equal(logicSymbol(lut(3, "8'hCA")).kind, 'block');
  assert.equal(logicSymbol(lut(6, "64'h8000000000000000")).kind, 'and');
  assert.equal(logicSymbol(lut(2, "4'hF8")).kind, 'block');
  assert.equal(logicSymbol(lut(2, '')).kind, 'block');
});

test('flip-flops, buffers, supply and port symbols retain layout connections', async () => {
  const data = { kind: 'schematic' as const, title: 'top', part, generatedAt: '', source: '',
    nodes: [
      { id: 'a', name: 'a', type: 'IN PORT', port: true, pins: [{ id: 'ap', name: 'a', direction: 'OUT' as const, net: 'a' }] },
      { id: 'b', name: 'ff', type: 'FDRE', port: false, pins: [{ id: 'bp', name: 'D', direction: 'IN' as const, net: 'a' }] },
    ],
  };
  assert.equal(logicSymbol(data.nodes[0]).kind, 'portIn');
  assert.equal(logicSymbol(data.nodes[1]).kind, 'flipflop');
  assert.equal(logicSymbol({ ...data.nodes[1], type: 'IBUF' }).kind, 'buffer');
  assert.equal(logicSymbol({ ...data.nodes[1], type: 'GND' }).kind, 'ground');
  const layout = await layoutCircuit(data);
  assert.equal(layout.graph.edges!.length, 1);
  assert.ok(layout.graph.edges![0].sections?.length);
});

test('I/O constraints are included last and do not invalidate the synthesized port list', async () => {
  await fs.mkdir(path.resolve('.test-work'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-work/io-unit-'));
  await fs.mkdir(path.join(root, 'constraints'));
  await fs.writeFile(path.join(root, 'top.v'), 'module top(input a, output b); assign b = a; endmodule\n');
  const config = validateConfig({ version: 1, name: 'io', part, top: 'top', sources: ['*.v'], constraints: ['constraints/*.xdc'] });
  await writeConfig(root, config);
  const tool = { root: 'D:/vivado', version: '2018.3' } as Toolchain;
  const before = await resolveProject(root), design = await designFingerprint(before, tool), all = await projectFingerprint(before, tool);
  await fs.writeFile(path.join(root, 'constraints/a-plan.xdc'), '# planning\n');
  await fs.writeFile(path.join(root, 'constraints/z-board.xdc'), '# board\n');
  config.ioConstraints = 'constraints/a-plan.xdc';
  await writeConfig(root, config);
  const after = await resolveProject(root);
  assert.equal(path.basename(after.files.constraints.at(-1)!), 'a-plan.xdc');
  assert.equal(after.files.constraints.length, 2);
  assert.equal(await designFingerprint(after, tool), design);
  assert.notEqual(await projectFingerprint(after, tool), all);
  assert.match(syncProjectTcl(after), /PROCESSING_ORDER LATE/);
  assert.throws(() => validateConfig({ ...config, ioConstraints: 'file.tcl' }), /ioConstraints/);
});
