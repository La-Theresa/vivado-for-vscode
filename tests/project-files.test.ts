import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectFolder } from '../src/project/create';
import { FileGroup, readConfig, resolveProject, validateConfig, writeConfig } from '../src/project/config';
import { createProjectFile, fileModuleName, newFileDirectory, sourceTemplate } from '../src/project/files';

const config = validateConfig({ version: 1, name: 'example', part: 'xc7a35tcsg324-1', top: 'top', sources: [] });

test('new HDL and constraint templates contain project headers and matching module names', () => {
  for (const extension of ['v', 'sv']) {
    const source = sourceTemplate(config, 'sources', `counter.${extension}`, '2018.3', new Date('2026-09-29T12:00:00Z'));
    for (const field of ['Company:', 'Engineer:', 'Create Date: 2026-09-29T12:00:00.000Z', 'Design Name: top',
      'Module Name: counter', 'Project Name: example', 'Target Devices: xc7a35tcsg324-1', 'Tool Versions: Vivado 2018.3',
      'Description:', 'Dependencies:', 'Revision 0.01 - File Created', 'Additional Comments:']) assert.ok(source.includes(`// ${field}`));
    assert.match(source, /^`timescale 1ns \/ 1ps/);
    assert.match(source, /module counter \(\s*\);\s*endmodule/);
    assert.doesNotMatch(source, /\$finish/);
    const simulation = sourceTemplate(config, 'simulation', `tb_counter.${extension}`);
    assert.match(simulation, /module tb_counter;/);
    assert.match(simulation, /reg clk = 1'b0;\s+always #5 clk = ~clk;/);
    assert.match(simulation, /initial begin/);
    assert.match(simulation, /#1000;\s+\$finish;/);
  }
  const constraints = sourceTemplate(config, 'constraints', 'board pins.xdc');
  assert.match(constraints, /# Project Name: example/);
  assert.doesNotMatch(constraints, /`timescale|\bmodule\b|\bendmodule\b/);
});

test('new file defaults follow native filesets or existing source directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-file-dirs-'));
  try {
    const native = await createProjectFolder(root, 'native', config.part, 'top');
    const project = await resolveProject(native);
    for (const [group, fileset] of [['sources', 'sources_1'], ['simulation', 'sim_1'], ['constraints', 'constrs_1']] as const) {
      assert.equal(newFileDirectory(project, group), path.join(native, `native.srcs/${fileset}/new`));
    }
    await writeConfig(root, config);
    assert.equal(newFileDirectory(await resolveProject(root), 'sources'), path.join(root, 'rtl'));
    await createProjectFile(root, 'sources', path.join(root, 'custom/first.v'));
    assert.equal(path.resolve(newFileDirectory(await resolveProject(root), 'sources')), path.join(root, 'custom'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('creating project files registers escaped paths, initializes tops, and preserves existing files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-files-'));
  try {
    await writeConfig(root, config);
    const source = path.join(root, 'rtl [new]/counter.sv');
    await createProjectFile(root, 'sources', source, '2018.3');
    const before = await fs.readFile(source, 'utf8');
    await createProjectFile(root, 'simulation', path.join(root, 'sim/tb_counter.v'));
    await createProjectFile(root, 'constraints', path.join(root, 'constraints/board pins.xdc'));
    let resolved = await resolveProject(root);
    assert.equal(resolved.config.top, 'counter');
    assert.equal(resolved.config.simulationTop, 'tb_counter');
    assert.deepEqual(resolved.files.sources.map(file => path.resolve(file)), [source]);
    assert.equal(resolved.files.simulation.length, 1);
    assert.equal(resolved.files.constraints.length, 1);
    await createProjectFile(root, 'sources', path.join(root, 'rtl/extra.v'));
    await createProjectFile(root, 'simulation', path.join(root, 'sim/extra_tb.sv'));
    resolved = await resolveProject(root);
    assert.equal(resolved.config.top, 'counter');
    assert.equal(resolved.config.simulationTop, 'tb_counter');
    const configBefore = await readConfig(root);
    await assert.rejects(createProjectFile(root, 'sources', source), /already exists/);
    assert.equal(await fs.readFile(source, 'utf8'), before);
    assert.deepEqual(await readConfig(root), configBefore);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('new files cannot preempt native project creation or target generated/outside paths', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-files-safe-'));
  try {
    const root = await createProjectFolder(parent, 'native', config.part, 'top');
    const source = path.join(root, 'native.srcs/sources_1/new/top.v');
    await assert.rejects(createProjectFile(root, 'sources', source), /Synchronize/);
    await assert.rejects(fs.access(path.join(root, 'native.srcs')), { code: 'ENOENT' });
    await fs.writeFile(path.join(root, 'native.xpr'), 'unit test placeholder');
    await createProjectFile(root, 'sources', source);
    for (const filename of ['../outside.v', '.vivado/top.v', 'native.sim/top.v', 'native.runs/top.v', '.git/top.v']) {
      await assert.rejects(createProjectFile(root, 'sources', path.resolve(root, filename)), /inside the project/);
    }
    for (const filename of ['bad-name.v', '2bad.sv', 'nul.v', 'top.txt', 'top.vh']) {
      await assert.rejects(createProjectFile(root, 'sources', path.join(root, filename)), /module name|filename/);
    }
    for (const [group, filename] of [['constraints', 'pins.v'], ['constraints', 'CON.xdc'], ['simulation', 'bad name.sv']] as [FileGroup, string][]) {
      assert.throws(() => fileModuleName(filename, group));
    }
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test('new files remove exact exclusions but report a conflicting broad exclusion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-file-exclude-'));
  try {
    await writeConfig(root, { ...config, exclude: ['rtl/top.v', 'blocked/**'] });
    await createProjectFile(root, 'sources', path.join(root, 'rtl/top.v'));
    assert.deepEqual((await readConfig(root)).exclude, ['blocked/**']);
    await assert.rejects(createProjectFile(root, 'sources', path.join(root, 'blocked/other.v')), /exclusion pattern/);
    await fs.access(path.join(root, 'blocked/other.v'));
    assert.equal((await resolveProject(root)).files.sources.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
