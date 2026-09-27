import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local-vivado.vivado-for-vscode');
  assert.ok(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  assert.ok(api.getToolchain(root));
  const file = path.join(root, 'rtl/top.v');
  const original = await fs.readFile(file, 'utf8');
  const document = await vscode.workspace.openTextDocument(file);
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
}
