import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectFolder, createProjectSourceFolders } from '../src/project/create';
import { CONFIG_FILE, portablePath, readConfig, resolveProject, validateConfig, writeConfig } from '../src/project/config';
import { ProjectIndex, isInside } from '../src/project/projects';
import { consoleShell, consoleStartupTcl } from '../src/toolchain/console';
import { syncProjectTcl } from '../src/project/sync';

test('new projects use the native Vivado layout without replacing existing files', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-create-'));
  try {
    const root = await createProjectFolder(parent, 'demo', 'xc7a35tcsg324-1', 'top');
    const project = await resolveProject(root);
    assert.equal(project.projectDir, root);
    assert.equal(project.xpr, path.join(root, 'demo.xpr'));
    assert.equal(project.config.simulationRunTime, '1 us');
    await assert.rejects(fs.access(path.join(root, 'demo.srcs')), { code: 'ENOENT' });
    await assert.rejects(createProjectSourceFolders(project), { code: 'ENOENT' });
    await fs.writeFile(project.xpr, 'unit test XPR placeholder');
    await createProjectSourceFolders(project);
    for (const fileset of ['sources_1', 'constrs_1', 'sim_1']) {
      assert.ok((await fs.stat(path.join(root, 'demo.srcs', fileset, 'new'))).isDirectory());
    }
    const source = path.join(root, 'demo.srcs/sources_1/new/top.v');
    await fs.writeFile(source, 'module top; endmodule\n');
    assert.equal((await resolveProject(root)).files.sources.length, 1);
    assert.match(syncProjectTcl(project), /create_project "demo"/);
    const config = await fs.readFile(path.join(root, CONFIG_FILE), 'utf8');
    await assert.rejects(createProjectFolder(parent, 'demo', 'xc7a35tcsg324-1', 'other'), /already exists/);
    assert.equal(await fs.readFile(path.join(root, CONFIG_FILE), 'utf8'), config);
    assert.equal(await fs.readFile(source, 'utf8'), 'module top; endmodule\n');
    await assert.rejects(createProjectFolder(parent, '../outside', 'xc7a35tcsg324-1', 'top'), /Invalid project name/);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test('projectDirectory is opt-in, contained, and excludes native generated files', async () => {
  const config = await readConfig(path.resolve('examples/counter'));
  const legacy = await resolveProject(path.resolve('examples/counter'));
  assert.equal(legacy.projectDir, path.resolve('examples/counter/.vivado/project'));
  for (const directory of ['../escape', 'a/../../escape', '/absolute', 'C:\\outside', 'C:relative', '\\\\server\\share', '..\\escape']) {
    assert.throws(() => validateConfig({ ...config, projectDirectory: directory }), /projectDirectory/);
  }
  assert.equal(validateConfig({ ...config, projectDirectory: 'build\\project' }).projectDirectory, 'build/project');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-native-'));
  try {
    await fs.mkdir(path.join(root, 'native.runs/synth_1'), { recursive: true });
    await fs.writeFile(path.join(root, 'native.runs/synth_1/generated.v'), 'module generated; endmodule');
    await fs.writeFile(path.join(root, 'top.v'), 'module top; endmodule');
    const native = await resolveProject(root, validateConfig({ ...config, projectDirectory: '.', sources: ['**/*.v'] }));
    assert.deepEqual(native.files.sources.map(file => path.basename(file)), ['top.v']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project ownership supports nested projects, external sources, close, reopen and persistence', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-projects-'));
  try {
    const workspace = path.join(base, 'workspace');
    await fs.mkdir(workspace);
    const root = await createProjectFolder(workspace, 'first', 'xc7a35tcsg324-1', 'top');
    const second = await createProjectFolder(root, 'second', 'xc7a35tcsg324-1', 'sub');
    await fs.mkdir(path.join(base, '.test-work'));
    const external = path.join(base, '.test-work', 'external.sv');
    await fs.writeFile(external, 'module external; endmodule');
    const config = await readConfig(root);
    config.sources.push(portablePath(external));
    await writeConfig(root, config);
    const ignored = path.join(workspace, '.vivado');
    await fs.mkdir(ignored);
    await createProjectFolder(ignored, 'generated', 'xc7a35tcsg324-1', 'top');
    const index = new ProjectIndex();
    await index.refresh([workspace]);
    assert.equal(index.roots.length, 2);
    assert.deepEqual(index.owners(external), [root]);
    assert.deepEqual(index.owners(path.join(second, 'new.v')), [second]);
    assert.equal(isInside(root, path.join(workspace, 'first-other/top.v')), false);
    index.close(second);
    await index.refresh([workspace]);
    assert.equal(index.has(second), false);
    assert.deepEqual(index.owners(path.join(second, 'new.v')), []);
    index.close(root);
    assert.deepEqual(index.owners(external), []);
    const restored = new ProjectIndex(index.closedRoots);
    await restored.refresh([workspace]);
    assert.deepEqual(restored.roots, []);
    restored.open(root);
    await restored.refresh([], [root]);
    assert.deepEqual(restored.owners(external), [root]);
    await fs.access(path.join(root, CONFIG_FILE));
    await fs.access(external);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('Tcl Console is interactive and safely launches Windows batch paths', async () => {
  const project = await resolveProject(path.resolve('examples/counter'));
  const startup = consoleStartupTcl(project);
  assert.match(startup, /open_project/);
  assert.doesNotMatch(startup, /\bexit\b|@@BEGIN|@@END/);
  assert.doesNotMatch(startup, /open_hw|connect_hw_server/);
  const windows = consoleShell('C:/tools with spaces/Vivado/bin/vivado.bat', 'C:/projects with spaces/console.tcl', 'win32');
  assert.match(windows.shellPath, /cmd\.exe$/i);
  assert.match(windows.shellArgs as string, /\/d \/s \/v:off \/c ""C:\/tools with spaces/);
  assert.match(windows.shellArgs as string, /"-mode" "tcl"/);
  assert.throws(() => consoleShell('C:/tool/vivado.bat', 'C:/bad%path/script.tcl', 'win32'), /Windows batch arguments/);
  assert.deepEqual(consoleShell('/opt/vivado/bin/vivado', '/tmp/script.tcl', 'linux'), {
    shellPath: '/opt/vivado/bin/vivado', shellArgs: ['-mode', 'tcl', '-nolog', '-nojournal', '-source', '/tmp/script.tcl'],
  });
});

test('language support is required and project/console commands are reachable', async () => {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(manifest.extensionDependencies.includes('mshr-h.veriloghdl'));
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  const menus = manifest.contributes.menus;
  for (const command of ['openProject', 'closeProject', 'openTclConsole', 'closeTclConsole', 'createFile', 'clearSimulationCache']) {
    assert.ok(manifest.contributes.commands.some((item: { command: string }) => item.command === `vivado.${command}`));
  }
  const run = menus['editor/title'].find((item: { command?: string }) => item.command === 'vivado.simulate');
  assert.match(run.when, /vivado\.editorProject/);
  assert.match(run.when, /resourceExtname =~/);
  assert.match(run.when, /vh\|svh/);
  assert.ok(menus['view/item/context'].some((item: { command: string }) => item.command === 'vivado.closeProject'));
  assert.ok(menus['view/item/context'].some((item: { command: string; when: string }) => item.command === 'vivado.createFile' && item.when.includes('group')));
  assert.ok(menus['view/title'].some((item: { command: string }) => item.command === 'vivado.createFile'));
  assert.ok(menus['vivado.runMenu'].some((item: { command: string }) => item.command === 'vivado.clearSimulationCache'));
});
