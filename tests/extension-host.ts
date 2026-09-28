import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectFolder } from '../src/project/create';
import { tclString } from '../src/project/sync';
import { portablePath } from '../src/project/config';

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function run(): Promise<void> {
  assert.ok(process.env.VIVADO_EXTENSION_ID);
  const extension = vscode.extensions.getExtension(process.env.VIVADO_EXTENSION_ID);
  assert.ok(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  assert.ok(api.getToolchain(root));
  const file = path.join(root, 'rtl/top.v');
  const original = await fs.readFile(file, 'utf8');
  const document = await vscode.workspace.openTextDocument(file);
  assert.equal(document.languageId, 'verilog');
  const languageSupport = vscode.extensions.getExtension('mshr-h.veriloghdl');
  assert.ok(languageSupport);
  for (const [suffix, language] of [['sv', 'systemverilog'], ['vh', 'verilog'], ['svh', 'systemverilog'], ['xdc', 'xdc']]) {
    const probe = path.join(root, `language-probe.${suffix}`);
    await fs.writeFile(probe, suffix === 'xdc' ? '# constraints\n' : '// language probe\n');
    assert.equal((await vscode.workspace.openTextDocument(probe)).languageId, language);
    assert.ok(languageSupport.packageJSON.contributes.grammars.some((grammar: { language?: string }) => grammar.language === language));
  }
  console.log('PASS Extension Host: required HDL dependency, file associations and TextMate grammars');
  await vscode.window.showTextDocument(document);
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  await replace('module top;\n  wrong !!!;\nendmodule\n');
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(d => d.source === 'Vivado Syntax' && d.severity === vscode.DiagnosticSeverity.Error), 'unsaved syntax error');
  assert.equal(document.isDirty, true);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await replace(original);
  await api.checkWorkspace(root);
  await waitFor(() => !vscode.languages.getDiagnostics(document.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error), 'cleared diagnostics');
  await replace(original.replace('.d(sw)', '.missing(sw)'));
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(d => d.source === 'Vivado Elaboration' && d.range.start.line === 1), 'cross-module error at line 2');
  await replace(original);
  await api.checkWorkspace(root);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const headerFile = path.join(root, 'rtl/defs.vh');
  const headerText = '`define WIDTH 4\n';
  await fs.writeFile(headerFile, headerText);
  await replace('`include "defs.vh"\n' + original);
  const header = await vscode.workspace.openTextDocument(headerFile);
  const headerEdit = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(header.uri, new vscode.Range(0, 0, header.lineCount, 0), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  await headerEdit('invalid !!!\n');
  await waitFor(() => vscode.languages.getDiagnostics(header.uri).some(d => d.source === 'Vivado Syntax'), 'unsaved include diagnostic');
  await headerEdit(headerText);
  await api.checkWorkspace(root);
  await waitFor(() => !vscode.languages.getDiagnostics(header.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error), 'cleared include diagnostic');
  await replace(original);
  console.log('PASS Extension Host: activation, dirty source/header diagnostics, clearing and cross-module location');
  await document.save();
  await header.save();
  const settings = vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root));
  await settings.update('lint.onType', false, vscode.ConfigurationTarget.Workspace);
  await settings.update('lint.elaborate', 'none', vscode.ConfigurationTarget.Workspace);
  await settings.update('sim.runTime', 'all', vscode.ConfigurationTarget.WorkspaceFolder);
  const configFile = path.join(root, 'vivado-project.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  config.simulation = ['sim/forever.v'];
  config.simulationTop = 'forever_tb';
  config.simulationRunTime = '1 us';
  await fs.writeFile(configFile, JSON.stringify(config));
  await fs.writeFile(path.join(root, 'sim/forever.v'), '`timescale 1ns/1ps\nmodule forever_tb; reg clk = 0; always #5 clk = ~clk; endmodule\n');
  const rootUri = vscode.Uri.file(root);
  await vscode.commands.executeCommand('vivado.simulate', rootUri);
  const state = JSON.parse(await fs.readFile(path.join(root, '.vivado/sim/last-run.json'), 'utf8'));
  assert.match(await fs.readFile(path.join(state.directory, 'simulate.tcl'), 'utf8'), /^run 1 us$/m);
  assert.ok((await fs.stat(state.vcd)).size > 0);
  const waveTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => tab.label === 'Waveform: forever_tb').map(tab => ({ tab, group })));
  await waitFor(() => waveTabs().length === 1, 'waveform preview tab');
  assert.equal(waveTabs()[0].group.viewColumn, vscode.ViewColumn.Two);
  await vscode.commands.executeCommand('vivado.previewWaveform', rootUri);
  assert.equal(waveTabs().length, 1, 'Preview commands reuse an existing panel.');
  console.log('PASS Extension Host: project duration overrides workspace all; finite simulation and reusable right-side waveform tab');
  await vscode.commands.executeCommand('vivado.synthesize', rootUri);
  const schematic = await fs.readFile(path.join(root, '.vivado/reports/schematic.xml'), 'utf8');
  assert.match(schematic, /<cell /);
  await waitFor(() => vscode.window.tabGroups.all.some(group => group.viewColumn === vscode.ViewColumn.Two && group.tabs.some(tab => tab.label.startsWith('Schematic:'))), 'right-side schematic preview tab');
  const manifest = extension.packageJSON;
  assert.ok(manifest.contributes.menus['editor/title'].some((item: { command?: string }) => item.command === 'vivado.simulate'));
  assert.ok(manifest.contributes.menus['vivado.runMenu'].some((item: { command?: string }) => item.command === 'vivado.bitstream'));
  console.log('PASS Extension Host: synthesis exports netlist and opens right-side schematic; editor Run menu registered');
  assert.ok(manifest.contributes.commands.some((item: { command: string }) => item.command === 'vivado.planIo'));
  await vscode.commands.executeCommand('vivado.planIo', rootUri);
  const ioTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => tab.label === 'I/O Planning: top').map(tab => ({ tab, group })));
  await waitFor(() => ioTabs().length === 1, 'I/O Planning tab');
  assert.equal(ioTabs()[0].group.viewColumn, vscode.ViewColumn.Two);
  await vscode.commands.executeCommand('vivado.planIo', rootUri);
  assert.equal(ioTabs().length, 1);
  const deviceXml = await fs.readFile(path.join(root, '.vivado/io/device.xml'), 'utf8');
  assert.match(deviceXml, /part="xc7a35tcsg324-1"/);
  assert.equal((deviceXml.match(/<pin /g) || []).length, 210);
  console.log('PASS Extension Host: I/O Planning reuses column 2 and queries the actual part package');
  const external = path.join(path.dirname(root), `${path.basename(root)}-external.sv`);
  await fs.writeFile(external, 'module external_probe; endmodule\n');
  config.sources.push(portablePath(external));
  await fs.writeFile(configFile, JSON.stringify(config));
  await api.refreshProjects();
  assert.deepEqual(api.projectOwners(external), [root]);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(external));
  assert.match(manifest.contributes.menus['editor/title'].find((item: { command?: string }) => item.command === 'vivado.simulate').when, /resourceExtname/);
  console.log('PASS Extension Host: imported external HDL belongs to its project for Run actions');

  const nativeRoot = await createProjectFolder(root, 'native_console', config.part, 'top');
  await vscode.commands.executeCommand('vivado.openProject', vscode.Uri.file(nativeRoot));
  assert.ok(api.projectRoots().includes(nativeRoot));
  const terminal = await vscode.commands.executeCommand<vscode.Terminal>('vivado.openTclConsole', vscode.Uri.file(nativeRoot));
  assert.ok(terminal);
  assert.equal(await vscode.commands.executeCommand('vivado.openTclConsole', vscode.Uri.file(nativeRoot)), terminal);
  await fs.access(path.join(nativeRoot, 'native_console.xpr'));
  const consoleResult = path.join(nativeRoot, 'console-result.txt');
  terminal.sendText(`set f [open ${tclString(consoleResult)} w]; puts $f [get_property NAME [current_project]]; close $f`, true);
  const deadline = Date.now() + 30000;
  let result = '';
  while (Date.now() < deadline) {
    result = await fs.readFile(consoleResult, 'utf8').catch(() => '');
    if (result.trim() === 'native_console') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(result.trim(), 'native_console', 'Interactive Tcl evaluates commands against the synchronized project.');
  await api.closeProject(nativeRoot);
  assert.ok(!api.projectRoots().includes(nativeRoot));
  await waitFor(() => !vscode.window.terminals.includes(terminal), 'console closes with project');
  assert.deepEqual(api.projectOwners(path.join(nativeRoot, 'native_console.srcs/sources_1/new/top.v')), []);
  await api.refreshProjects();
  assert.ok(!api.projectRoots().includes(nativeRoot), 'Refresh must not reopen a closed project.');
  await fs.access(path.join(nativeRoot, 'native_console.xpr'));
  await vscode.commands.executeCommand('vivado.openProject', vscode.Uri.file(nativeRoot));
  assert.ok(api.projectRoots().includes(nativeRoot));
  await api.closeProject(nativeRoot);
  assert.equal(await vscode.commands.executeCommand('vivado.openTclConsole', vscode.Uri.file(nativeRoot)), undefined,
    'An explicit closed project must not fall back to a different open project.');
  const checking = api.checkWorkspace(root);
  await api.closeProject(root);
  await checking;
  assert.deepEqual(api.projectOwners(external), []);
  assert.ok(!vscode.languages.getDiagnostics().some(([, diagnostics]) => diagnostics.some(d => d.source?.startsWith('Vivado'))));
  assert.equal(waveTabs().length, 0);
  assert.equal(ioTabs().length, 0);
  await fs.access(file);
  await fs.access(configFile);
  console.log('PASS Extension Host: native project, interactive Tcl, console reuse, close/reopen and non-destructive cleanup');
}
