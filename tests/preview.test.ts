import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/project/config';
import { importXpr } from '../src/project/importXpr';
import { normalizeSimulationRunTime, simulationRunTime } from '../src/sim/runtime';
import { parseWaveform } from '../src/sim/waveform';
import { parseSchematic, schematicTcl } from '../src/build/schematic';
import { layoutCircuit } from '../src/views/circuitLayout';
import { previewHtml } from '../src/views/previewHtml';

const wasmFile = path.resolve('dist/vivado_vcd_parser.wasm');
const valid = { version: 1, name: 'test', part: 'xc7a35tcsg324-1', top: 'top', sources: ['*.v'] };

test('simulation duration defaults and project precedence are unambiguous', () => {
  assert.equal(simulationRunTime({}), '1 us');
  assert.equal(simulationRunTime({}, '5 ns'), '5 ns');
  assert.equal(simulationRunTime({ simulationRunTime: '2us' }, 'all'), '2 us');
  assert.equal(simulationRunTime({ simulationRunTime: 'all' }, '1 us'), 'all');
  assert.equal(validateConfig({ ...valid, simulationRunTime: ' 10ns ' }).simulationRunTime, '10 ns');
  for (const value of [0, null, '', '0 ns', '-1 ns', 'all; exit', 'infinity s']) assert.throws(() => normalizeSimulationRunTime(value));
  const imported = importXpr('<Project><Configuration><Option Name="Part" Val="xc7a35tcsg324-1"/></Configuration></Project>', path.resolve('test.xpr'), path.resolve('.'));
  assert.equal(imported.config.simulationRunTime, '1 us');
});

const vcd = `$timescale 1 ns $end
$scope module tb $end
$var wire 1 ! clk $end
$var wire 4 " bus [3:0] $end
$scope module dut $end
$var wire 1 ! clk_alias $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
b0000 "
$end
#5
1!
b10xz "
#10
0!
b11 "
#20
`;
test('VCD preview preserves aliases, buses, X/Z and the final timestamp', async () => {
  const data = await parseWaveform(vcd, 'wave.vcd', wasmFile);
  assert.equal(data.endTime, 20);
  assert.equal(data.unit, 'ns');
  assert.equal(data.timescale, 1);
  assert.equal(data.signals.length, 3);
  const clk = data.signals.find(signal => signal.name === 'tb.clk')!;
  assert.deepEqual(clk.changes, [[0, '0'], [5, '1'], [10, '0']]);
  assert.deepEqual(data.signals.find(signal => signal.name.endsWith('clk_alias'))!.changes, clk.changes);
  assert.deepEqual(data.signals.find(signal => signal.width === 4)!.changes, [[0, '0000'], [5, '10xz'], [10, '0011']]);
});

test('VCD preview does not drop changes at EOF or invent later simulation time', async () => {
  const data = await parseWaveform(vcd.replace('#20\n', ''), 'wave.vcd', wasmFile);
  assert.equal(data.endTime, 10);
  assert.deepEqual(data.signals[0].changes.at(-1), [10, '0']);
  await assert.rejects(parseWaveform('x'.repeat(8 * 1024 * 1024 + 1), 'large.vcd', wasmFile), /8 MiB/);
});

const xml = `<netlist top="top" part="xc7a35tcsg324-1" generatedAt="2026-09-27">
<cell name="gate&amp;one" type="LUT2"><pin name="I0" direction="IN" net="a"/><pin name="O" direction="OUT" net="f"/></cell>
<port name="A" direction="IN" net="a"/><port name="F" direction="OUT" net="f"/>
<count value="1"/></netlist>`;
test('schematic import preserves nets and top-port directions, then lays out real connections', async () => {
  const data = parseSchematic(xml, 'schematic.xml');
  assert.equal(data.nodes[0].name, 'gate&one');
  assert.equal(data.nodes[1].pins[0].direction, 'OUT');
  assert.equal(data.nodes[2].pins[0].direction, 'IN');
  const { graph, edgeNets } = await layoutCircuit(data);
  assert.ok(graph.width! > 0 && graph.height! > 0);
  assert.equal(graph.edges!.length, 2);
  assert.deepEqual([...edgeNets.values()], ['a', 'f']);
  assert.ok(graph.edges!.every(edge => edge.sections?.length));
});

test('schematic bounds and HTML security are enforced', () => {
  assert.throws(() => parseSchematic(xml.replace('value="1"', 'value="1001"'), ''), /preview limit/);
  assert.throws(() => parseSchematic('<!DOCTYPE netlist>' + xml, ''), /Invalid schematic/);
  assert.throws(() => parseSchematic(xml.replace('direction="IN"', 'direction="INVALID"'), ''), /direction/);
  const script = schematicTcl('D:/path with spaces/schematic.xml');
  assert.match(script, /IS_PRIMITIVE == 1/);
  assert.match(script, /get_nets -quiet -segments/);
  const html = previewHtml('https://local/preview.js', 'https://local/preview.css', 'https://local', 'safe-nonce');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-safe-nonce'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});
