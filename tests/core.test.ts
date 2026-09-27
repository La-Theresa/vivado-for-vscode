import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeToolPath, parseMessages, pathKey } from '../src/toolchain/messageParser';
import { validateConfig, discoverModules, resolveProject } from '../src/project/config';
import { guardedTcl, syncProjectTcl, tclList, tclString } from '../src/project/sync';
import { importXpr, splitTclList } from '../src/project/importXpr';
import { createShadow } from '../src/lint/shadow';
import { parallelMap } from '../src/lint/compiler';
import { parseUtilization } from '../src/build/reports';
import { buildTcl, projectFingerprint } from '../src/build/builder';
import { simulationRunCommand } from '../src/sim/simulator';
import { CancelledError, runProcess } from '../src/toolchain/process';
import { Toolchain } from '../src/toolchain/detect';

const valid = { version: 1, name: 'sample', part: 'xc7a35tcsg324-1', top: 'top', sources: ['rtl/*.v'] };
const fixture = path.resolve('examples/counter');

test('message parser handles drive duplication, severity, location and resolution', () => {
  const messages = parseMessages('ERROR: [VRFC 10-1412] syntax error [C:C:\\work dir\\top.v:12]\r\n  Resolution: fix token\r\nCRITICAL WARNING: [Timing 38-282] unconstrained\nWARNING: [Synth 8-327] latch [D:/rtl/sub.sv:4]');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].file, 'C:/work dir/top.v');
  assert.equal(messages[0].line, 11);
  assert.match(messages[0].message, /Resolution: fix token/);
  assert.equal(messages[1].severity, 'warning');
  assert.equal(messages[1].file, undefined);
  assert.equal(messages[2].id, 'Synth 8-327');
  assert.equal(normalizeToolPath('D:D:D:/x.v'), 'D:/x.v');
});

test('message parser maps shadow paths and ignores unrelated logs', () => {
  const messages = parseMessages('INFO: nothing\nERROR: [VRFC 10-1] problem [rtl/top.v:1]', fixture, () => 'original.v');
  assert.equal(messages[0].file, 'original.v');
  assert.equal(messages[0].line, 0);
});

test('message parser handles array expressions, bracketed directories and columns', () => {
  const messages = parseMessages('ERROR: [VRFC 1] invalid bus [3:0] [D:/a [copy]/top.sv:12:5]\nINFO: next stage\n  unrelated report row');
  assert.equal(messages[0].file, 'D:/a [copy]/top.sv');
  assert.equal(messages[0].line, 11);
  assert.equal(messages[0].message, 'invalid bus [3:0]');
});

test('config validates unknown fields, types, identifiers and defaults', () => {
  assert.deepEqual(validateConfig(valid).defines, []);
  for (const value of [{ ...valid, version: 2 }, { ...valid, sources: 'x' }, { ...valid, top: 'top;exit' }, { ...valid, name: '../bad' }, { ...valid, includes: [] }, { ...valid, defines: ['BAD VALUE'] }]) assert.throws(() => validateConfig(value));
});

test('Tcl values preserve spaces and escape substitution', () => {
  assert.equal(tclString('a $x [exit] "quoted"'), '"a \\$x \\[exit\\] \\"quoted\\""');
  assert.equal(tclList([]), '[list ]');
  assert.equal(tclString('\u4e2d\u6587'), '"\\u4e2d\\u6587"');
  assert.match(guardedTcl('error bad'), /exit 1/);
});

test('sync script uses incremental reconciliation and build reset semantics', async () => {
  const project = await resolveProject(fixture);
  const script = syncProjectTcl(project);
  assert.match(script, /remove_files -fileset/);
  assert.match(script, /add_files -fileset/);
  assert.doesNotMatch(script, /create_project -force/);
  assert.doesNotMatch(script, /\blmap\b/);
  const build = buildTcl(project, 'bitstream', 4, true);
  assert.match(build, /reset_run synth_1/);
  assert.match(build, /vscode_run impl_1 write_bitstream 4/);
  assert.match(build, /PROGRESS.*100%/);
  assert.throws(() => buildTcl(project, 'synthesis', 0, false));
});

test('XPR import parses XML entities, variables and repeated files', () => {
  const xml = `<Project><Configuration><Option Name="Part" Val="xc7a35tcsg324-1"/></Configuration><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/rtl/a &amp; b.v"/><File Path="$PSRCDIR/imports/sub.v"/><Config><Option Name="TopModule" Val="my_top"/><Option Name="IncludeDirs" Val="{$PPRDIR/include dir}"/><Option Name="VerilogDefines" Val="WIDTH=4 DEBUG"/></Config></FileSet><FileSet Name="sim_1" Type="SimulationSrcs"><File Path="$PPRDIR/tb.v"/><Config><Option Name="TopModule" Val="tb"/></Config></FileSet></FileSets></Project>`;
  const root = path.resolve('fixture');
  const result = importXpr(xml, path.join(root, 'demo.xpr'), root);
  assert.equal(result.config.sources[0], 'rtl/a & b.v');
  assert.equal(result.config.sources[1], 'demo.srcs/imports/sub.v');
  assert.equal(result.config.top, 'my_top');
  assert.equal(result.config.simulationTop, 'tb');
  assert.deepEqual(result.config.includeDirs, ['include dir']);
  assert.deepEqual(result.config.defines, ['WIDTH=4', 'DEBUG']);
  assert.throws(() => importXpr('<!DOCTYPE Project><Project/>', 'x.xpr', root));
  assert.throws(() => importXpr('<Project>', 'x.xpr', root));
});

test('Tcl list parser handles nested braces and quotes', () => {
  assert.deepEqual(splitTclList('{a b} "c d" {x {y}}'), ['a b', 'c d', 'x {y}']);
  assert.throws(() => splitTclList('{a'));
});

test('native 2018.3 XPR include and Define nodes survive import', () => {
  const xml = '<Project><Configuration><Option Name="Part" Val="xc7a35tcsg324-1"/></Configuration><FileSets><FileSet Name="sources_1"><Config><Option Name="TopModule" Val="top"/><Option Name="VerilogDir" Val="$PPRDIR/include dir"/><Define Name="DEBUG"/><Define Name="WIDTH" Val="4"/></Config></FileSet><FileSet Name="sim_1"><Config><Define Name="WIDTH" Val="8"/></Config></FileSet></FileSets></Project>';
  const root = path.resolve('xpr-native');
  const imported = importXpr(xml, path.join(root, 'demo.xpr'), root);
  assert.deepEqual(imported.config.includeDirs, ['include dir']);
  assert.deepEqual(imported.config.defines, ['DEBUG', 'WIDTH=4']);
  assert.ok(imported.warnings.some(w => w.includes('Different design/simulation')));
});

test('module discovery ignores comments and strings', () => {
  assert.deepEqual(discoverModules('// module wrong;\nmodule automatic real_top; initial $display("module fake;"); endmodule /* module no; */'), ['real_top']);
});

test('shadow snapshot preserves dirty source/header and maps originals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-shadow-test-'));
  try {
    const original = path.join(root, 'top.v'), header = path.join(root, 'defs.vh');
    await fs.writeFile(original, 'module saved; endmodule');
    await fs.writeFile(header, '`define VALUE 1');
    const shadow = await createShadow(root, [original], [], [{ file: original, text: 'module dirty; endmodule' }, { file: header, text: '`define VALUE 2' }]);
    try {
      assert.equal(await fs.readFile(shadow.file(original), 'utf8'), 'module dirty; endmodule');
      assert.equal(await fs.readFile(shadow.file(header), 'utf8'), '`define VALUE 2');
      assert.equal(pathKey(shadow.original(shadow.file(original))), pathKey(original));
      assert.equal(await fs.readFile(original, 'utf8'), 'module saved; endmodule');
    } finally { await shadow.dispose(); }
    assert.equal(await fs.access(shadow.directory).then(() => true, () => false), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('parallel checker observes limit and preserves result order', async () => {
  let active = 0, maximum = 0;
  const result = await parallelMap([1, 2, 3, 4], 2, async value => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result, [2, 4, 6, 8]);
});

test('reports and simulation duration parsing', () => {
  const rows = parseUtilization('| Slice LUTs* | 4 | 0 | 20800 | 0.02 |\n| Block RAM Tile | 0 | 50 | 0.00 |');
  assert.deepEqual(rows[0], { name: 'Slice LUTs', used: '4', available: '20800', percent: '0.02' });
  assert.equal(rows[1].available, '50');
  assert.equal(simulationRunCommand('1 us'), 'run 1 us');
  assert.equal(simulationRunCommand('all'), 'run all');
  assert.throws(() => simulationRunCommand('all; exec bad'));
});

test('process wrapper streams output and cancellation rejects', async () => {
  let output = '';
  const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'], { cwd: fixture, onOutput: text => { output += text; } });
  assert.equal(result.code, 0);
  assert.match(output, /hello/);
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: fixture, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, CancelledError);
});

test('process wrapper decodes split GBK characters without corruption', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xd6])); setTimeout(() => process.stdout.write(Buffer.from([0xd0])), 20)'], { cwd: fixture, encoding: 'gbk' });
  assert.equal(result.output, '\u4e2d');
});

test('cancelled tools do not launch', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess('nonexistent-executable', [], { cwd: fixture, signal: controller.signal }), CancelledError);
});

test('fingerprint changes with content, not only timestamps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-fingerprint-'));
  try {
    await fs.cp(fixture, root, { recursive: true, filter: source => !source.includes('.vivado') });
    const project = await resolveProject(root), tools = { root: 'tools', version: '2018.3' } as Toolchain;
    const before = await projectFingerprint(project, tools);
    await fs.appendFile(path.join(root, 'rtl/top.v'), '\n// changed\n');
    assert.notEqual(await projectFingerprint(project, tools), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
