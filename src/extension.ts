import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectToolchain, Toolchain } from './toolchain/detect';
import { CancelledError, requireSuccess, spawnTool } from './toolchain/process';
import { TclSession } from './toolchain/tclSession';
import { CONFIG_FILE, FileGroup, discoverModules, portablePath, readConfig, resolveProject, validateConfig, writeConfig } from './project/config';
import { importXpr } from './project/importXpr';
import { installedParts } from './project/parts';
import { syncProjectTcl } from './project/sync';
import { Linter } from './lint/linter';
import { clearWorkspaceDiagnostics, publishWorkspaceDiagnostics } from './lint/diagnostics';
import { BuildStage, buildProject, projectFingerprint, readBuildState, runBatch } from './build/builder';
import { openWaveformTcl, readSimulation, simulate, simulationTops } from './sim/simulator';
import { hardwareDevices, hardwareTargets, NoHardwareError, programDevice } from './hw/hardware';
import { ProjectNode, ProjectTree } from './views/projectTree';
import { showReports } from './views/reportsPanel';
import { PreviewPanels } from './views/previewPanel';
import { DEFAULT_SIMULATION_RUN_TIME, simulationRunTime } from './sim/runtime';
import { readIoPlan, saveIoPlan } from './io/planner';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Vivado');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const tree = new ProjectTree();
  const buildDiagnostics = vscode.languages.createDiagnosticCollection('Vivado Build');
  const simDiagnostics = vscode.languages.createDiagnosticCollection('Vivado Simulation');
  const tools = new Map<string, Toolchain>();
  const sessions = new Map<string, TclSession>();
  const running = new Map<string, AbortController>();
  const log = (text: string) => output.append(text);
  const linter = new Linter(root => tools.get(root), log);
  const previews = new PreviewPanels(context.extensionUri, {
    open: openIo,
    reload: async (root, dirty) => {
      if (dirty && await vscode.window.showWarningMessage('Discard unsaved I/O assignments and reload?', { modal: true }, 'Reload') !== 'Reload') return undefined;
      return loadIo(root);
    },
    save: async (root, data, entries) => {
      const chosen = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.resolve(root, data.constraintFile)), filters: { 'Xilinx Constraints': ['xdc'] }, title: 'Save I/O Planning Constraints' });
      if (!chosen) return undefined;
      await saveProjectFiles(root);
      const tools = await getTools(root);
      const saved = await operation(root, 'Save I/O constraints', async () => saveIoPlan(root, tools, data, entries, chosen.fsPath));
      tree.refresh();
      void vscode.window.showInformationMessage(`I/O constraints saved: ${saved.constraintFile}. Implementation DRC and board voltages still require verification.`);
      return saved;
    },
  });
  context.subscriptions.push(output, status, tree, linter, buildDiagnostics, simDiagnostics, previews,
    vscode.window.registerTreeDataProvider('vivado.project', tree),
    { dispose: () => { for (const controller of running.values()) controller.abort(); for (const session of sessions.values()) void session.dispose(); } });

  const configuration = (root: string) => vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root));
  let editorContextGeneration = 0;
  const updateEditorContext = async () => {
    const generation = ++editorContextGeneration;
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const hasProject = !!folder && folder.uri.scheme === 'file' && await fs.access(path.join(folder.uri.fsPath, CONFIG_FILE)).then(() => true, () => false);
    if (generation === editorContextGeneration) await vscode.commands.executeCommand('setContext', 'vivado.editorProject', hasProject);
  };
  const idleStatus = () => {
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath;
    const tool = (active && tools.get(active)) || tools.values().next().value;
    status.text = tool ? `$(circuit-board) Vivado ${tool.version}` : '$(warning) Vivado not found';
    status.tooltip = tool?.root || 'Select a Vivado installation';
    status.command = 'vivado.detect';
    status.show();
  };

  async function rootFor(value?: unknown): Promise<string> {
    if (value instanceof ProjectNode) return value.root;
    const uri = value instanceof vscode.Uri ? value : vscode.window.activeTextEditor?.document.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri.fsPath;
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
    if (!folders.length) throw new Error('Open a local workspace folder first.');
    if (folders.length === 1) return folders[0].uri.fsPath;
    const selected = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })), { title: 'Vivado workspace' });
    if (!selected) throw new CancelledError();
    return selected.root;
  }

  async function detect(root: string, select = false): Promise<Toolchain | undefined> {
    if (!vscode.workspace.isTrusted) return undefined;
    let setting = configuration(root).get<string>('installPath', '');
    let found = select ? undefined : await detectToolchain(setting);
    if (!found && select) {
      const choice = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Select Vivado version directory' });
      if (!choice?.length) return undefined;
      setting = choice[0].fsPath;
      found = await detectToolchain(setting);
      if (!found) throw new Error('This directory does not contain a working Vivado installation.');
      await configuration(root).update('installPath', setting, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await sessions.get(root)?.dispose();
    sessions.delete(root);
    if (found) tools.set(root, found); else tools.delete(root);
    idleStatus();
    linter.refresh();
    return found;
  }

  async function getTools(root: string): Promise<Toolchain> {
    const tool = tools.get(root) || await detect(root);
    if (tool) return tool;
    const answer = await vscode.window.showWarningMessage('Vivado was not found.', 'Select Installation');
    if (answer) {
      const selected = await detect(root, true);
      if (selected) return selected;
    }
    throw new CancelledError();
  }

  async function sessionFor(root: string): Promise<TclSession> {
    const tool = await getTools(root);
    let session = sessions.get(root);
    if (!session) {
      const cwd = path.join(os.tmpdir(), 'vivado-vscode', 'sessions');
      await fs.mkdir(cwd, { recursive: true });
      session = new TclSession(tool.vivado, cwd, configuration(root).get('outputEncoding', 'utf8'), log);
      sessions.set(root, session);
    }
    return session;
  }

  async function operation<T>(root: string, title: string, action: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T> {
    if (running.has(root)) throw new Error('A Vivado operation is already running for this workspace. Cancel it or wait for completion.');
    const controller = new AbortController();
    running.set(root, controller);
    await vscode.commands.executeCommand('setContext', 'vivado.running', true);
    output.show(true);
    log(`\n=== ${title} ===\n`);
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        const listener = token.onCancellationRequested(() => controller.abort());
        const report = (message: string) => { progress.report({ message }); status.text = `$(sync~spin) ${message}`; status.command = 'vivado.cancel'; };
        report(title);
        try { return await action(controller.signal, report); } finally { listener.dispose(); }
      });
    } finally {
      running.delete(root);
      await vscode.commands.executeCommand('setContext', 'vivado.running', running.size > 0);
      idleStatus(); tree.refresh();
    }
  }

  function command(name: string, action: (...args: any[]) => unknown) {
    context.subscriptions.push(vscode.commands.registerCommand(`vivado.${name}`, async (...args) => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Trust this workspace to run Vivado.'); return; }
      try { return await action(...args); }
      catch (error) {
        if (error instanceof CancelledError) { log('Cancelled.\n'); return; }
        log(`${String(error)}\n`);
        void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error).slice(0, 600), 'Show Output').then(choice => { if (choice) output.show(); });
      }
    }));
  }

  async function selectPart(root: string): Promise<string | undefined> {
    const tool = await getTools(root);
    const parts = await operation(root, 'Query installed devices', async signal => installedParts(tool, context.globalStorageUri.fsPath, await sessionFor(root), signal));
    const preferred = ['xc7a35tcsg324-1', 'xc7a100tcsg324-1'];
    return vscode.window.showQuickPick([...parts].sort((a, b) => (preferred.includes(a) ? -1 : 0) - (preferred.includes(b) ? -1 : 0) || a.localeCompare(b)), { title: 'Installed FPGA devices', placeHolder: 'Search by part number' });
  }

  async function allowOverwrite(root: string): Promise<boolean> {
    const exists = await fs.access(path.join(root, CONFIG_FILE)).then(() => true, () => false);
    return !exists || await vscode.window.showWarningMessage('Replace the existing vivado-project.json?', { modal: true }, 'Replace') === 'Replace';
  }

  async function synchronize(root: string): Promise<void> {
    const tool = await getTools(root);
    const project = await resolveProject(root);
    await operation(root, 'Synchronize Vivado project', async signal => {
      requireSuccess(await runBatch(tool, syncProjectTcl(project) + '\nclose_project\n', path.join(root, '.vivado', 'scripts', 'sync.tcl'), { cwd: root, signal, encoding: configuration(root).get('outputEncoding', 'utf8'), onOutput: log }), 'Project synchronization');
    });
  }

  async function saveProjectFiles(root: string): Promise<void> {
    const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath === root);
    if (dirty.length && await vscode.window.showWarningMessage('Save modified workspace files before running Vivado?', { modal: true }, 'Save and Continue') !== 'Save and Continue') throw new CancelledError();
    for (const document of dirty) if (!await document.save()) throw new Error(`Could not save ${document.fileName}`);
  }

  command('detect', async value => { const root = await rootFor(value); await detect(root, true); });
  command('refresh', async () => { tree.refresh(); linter.refresh(); });
  command('cancel', () => { for (const controller of running.values()) controller.abort(); });
  command('check', async value => { const root = await rootFor(value); await getTools(root); await linter.checkWorkspace(root); });
  command('reports', async value => showReports(await rootFor(value)));
  async function showSchematic(root: string): Promise<void> {
    const state = await readBuildState(root), project = await resolveProject(root), tool = await getTools(root);
    await previews.schematic(root, !state || state.fingerprint !== await projectFingerprint(project, tool));
  }
  async function autoPreview(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) {
      log(`Preview: ${String(error)}\n`);
      void vscode.window.showWarningMessage(`Run completed, but preview is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  command('previewWaveform', async value => previews.waveform(await rootFor(value)));
  command('previewSchematic', async value => showSchematic(await rootFor(value)));
  async function loadIo(root: string) {
    await saveProjectFiles(root);
    const project = await resolveProject(root), tools = await getTools(root);
    return operation(root, 'Read device I/O', async signal => readIoPlan(project, tools, await sessionFor(root), signal));
  }
  async function openIo(root: string, port?: string): Promise<void> {
    await refreshIoProject(root);
    if (previews.revealIo(root, port)) return;
    const data = await loadIo(root);
    data.selectedPort = port;
    previews.io(root, data);
  }
  async function refreshIoProject(root: string): Promise<void> {
    const config = await readConfig(root).catch(() => undefined);
    previews.checkIoProject(root, config);
  }
  command('planIo', async value => openIo(await rootFor(value)));
  command('createProject', async value => {
    const root = await rootFor(value);
    if (!await allowOverwrite(root)) return;
    const part = await selectPart(root);
    if (!part) return;
    const name = await vscode.window.showInputBox({ title: 'Project name', value: 'fpga_project', validateInput: value => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? undefined : 'Use letters, numbers, underscores and hyphens.' });
    if (!name) return;
    const top = await vscode.window.showInputBox({ title: 'Top module', value: 'top', validateInput: value => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) ? undefined : 'Enter a Verilog module identifier.' });
    if (!top) return;
    await writeConfig(root, validateConfig({ version: 1, name, part, top, simulationRunTime: DEFAULT_SIMULATION_RUN_TIME, sources: ['rtl/**/*.{v,sv,vh,svh}', '*.{v,sv,vh,svh}'], constraints: ['constraints/**/*.xdc', '*.xdc'], simulation: ['sim/**/*.{v,sv}', 'tb/**/*.{v,sv}'] }));
    await synchronize(root);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, CONFIG_FILE)));
  });
  command('importProject', async value => {
    const root = await rootFor(value);
    if (!await allowOverwrite(root)) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Vivado Project': ['xpr'] } });
    if (!files?.length) return;
    const imported = importXpr(await fs.readFile(files[0].fsPath, 'utf8'), files[0].fsPath, root);
    await writeConfig(root, imported.config);
    for (const warning of imported.warnings) log(warning + '\n');
    await synchronize(root);
    void vscode.window.showInformationMessage('Project imported. Import limitations are listed in Vivado Output.');
  });
  command('selectPart', async value => {
    const root = await rootFor(value), part = await selectPart(root);
    if (part) { const config = await readConfig(root); config.part = part; await writeConfig(root, config); tree.refresh(); }
  });
  command('setTop', async (node?: ProjectNode) => {
    const root = await rootFor(node);
    const uri = node?.file ? vscode.Uri.file(node.file) : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const modules = discoverModules(document.getText());
    if (!modules.length) throw new Error('No module declarations found in this file.');
    const top = modules.length === 1 ? modules[0] : await vscode.window.showQuickPick(modules, { title: 'Top module' });
    if (!top) return;
    const config = await readConfig(root);
    if (node?.group === 'simulation') config.simulationTop = top; else config.top = top;
    await writeConfig(root, config);
    tree.refresh();
  });
  command('addFile', async value => {
    const root = await rootFor(value);
    const choices = [{ label: 'Design Sources', group: 'sources' }, { label: 'Constraints', group: 'constraints' }, { label: 'Simulation Sources', group: 'simulation' }] as const;
    const group = value instanceof ProjectNode && value.group ? value.group : (await vscode.window.showQuickPick(choices, { title: 'File category' }))?.group;
    if (!group) return;
    const files = value instanceof vscode.Uri ? [value] : await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(root) });
    if (!files?.length) return;
    const config = await readConfig(root);
    for (const uri of files) {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile()) throw new Error('Select files, not a directory.');
      const relative = portablePath(path.relative(root, uri.fsPath));
      if (!config[group].includes(relative)) config[group].push(relative);
      config.exclude = config.exclude.filter(file => file !== relative);
    }
    await writeConfig(root, config);
    tree.refresh();
  });
  command('removeFile', async (node: ProjectNode) => {
    if (!node?.file || !node.group) return;
    const config = await readConfig(node.root);
    const relative = portablePath(path.relative(node.root, node.file));
    config[node.group] = config[node.group].filter(file => file !== relative);
    if (config.ioConstraints && path.resolve(node.root, config.ioConstraints).toLowerCase() === path.resolve(node.file).toLowerCase()) delete config.ioConstraints;
    if (!config.exclude.includes(relative)) config.exclude.push(relative);
    await writeConfig(node.root, config);
    tree.refresh();
  });

  async function runBuild(stage: BuildStage, value?: unknown, rebuild = false) {
    const root = await rootFor(value);
    await saveProjectFiles(root);
    const tool = await getTools(root), project = await resolveProject(root), settings = configuration(root);
    clearWorkspaceDiagnostics(buildDiagnostics, root);
    const result = await operation(root, `Vivado ${stage}`, async (signal, report) => buildProject(tool, project, stage, {
      cwd: root, signal, jobs: settings.get('build.jobs', 4), rebuild, encoding: settings.get('outputEncoding', 'utf8'),
      onOutput: text => { log(text); const match = text.match(/@@VSCODE_PROGRESS:([^:]+):(\d+)@@/); if (match) report(`${match[1]} ${match[2]}%`); },
      onMessages: messages => publishWorkspaceDiagnostics(buildDiagnostics, root, messages, path.join(root, CONFIG_FILE)),
    }));
    void vscode.window.showInformationMessage(result.state.bitstream ? `Bitstream generated: ${result.state.bitstream}` : `Vivado ${stage} complete.`);
    if (stage === 'synthesis') await autoPreview(() => showSchematic(root));
    return result;
  }
  command('synthesize', value => runBuild('synthesis', value));
  command('implement', value => runBuild('implementation', value));
  command('bitstream', value => runBuild('bitstream', value));
  command('buildAll', value => runBuild('bitstream', value, true));

  command('openGui', async value => {
    const root = await rootFor(value);
    await saveProjectFiles(root);
    await synchronize(root);
    const project = await resolveProject(root), tool = await getTools(root);
    const child = spawnTool(tool.vivado, ['-mode', 'gui', portablePath(project.xpr)], root);
    child.on('error', error => { void vscode.window.showErrorMessage(error.message); });
    child.stdout!.on('data', data => log(data.toString()));
    child.stderr!.on('data', data => log(data.toString()));
    child.stdin!.end();
    child.unref();
  });
  command('simulate', async value => {
    const root = await rootFor(value);
    await saveProjectFiles(root);
    const project = await resolveProject(root), tool = await getTools(root), settings = configuration(root);
    const tops = await simulationTops(project);
    if (!tops.length) throw new Error('Add testbench files under simulation or set simulationTop in vivado-project.json.');
    const top = tops.length === 1 ? tops[0] : await vscode.window.showQuickPick(tops, { title: 'Simulation top' });
    if (!top) return;
    const runTime = simulationRunTime(project.config, settings.get<string>('sim.runTime'));
    clearWorkspaceDiagnostics(simDiagnostics, root);
    const write = new vscode.EventEmitter<string>();
    let ready = false, pending = '';
    let cancelSimulation = () => {};
    const terminal = vscode.window.createTerminal({ name: `Vivado: ${top}`, pty: {
      onDidWrite: write.event, open: () => { ready = true; write.fire(pending); pending = ''; },
      close: () => { cancelSimulation(); write.dispose(); },
    } });
    terminal.show(true);
    context.subscriptions.push(terminal, write);
    await operation(root, 'Vivado simulation', async signal => {
      log(`Simulation top: ${top}; duration: ${runTime}${project.config.simulationRunTime ? ' (vivado-project.json)' : ' (VS Code setting/default)'}\n`);
      const owner = running.get(root);
      cancelSimulation = () => owner?.abort();
      return simulate(tool, project, top, {
      cwd: root, signal, runTime, timescale: settings.get('sim.defaultTimescale', '1ns/1ps'), encoding: settings.get('outputEncoding', 'utf8'),
      onOutput: text => { log(text); const formatted = text.replace(/\r?\n/g, '\r\n'); if (ready) write.fire(formatted); else pending += formatted; },
      onMessages: messages => publishWorkspaceDiagnostics(simDiagnostics, root, messages, path.join(root, CONFIG_FILE)),
      });
    }).finally(() => { cancelSimulation = () => {}; });
    void vscode.window.showInformationMessage('Simulation complete. WDB and VCD are available.');
    await autoPreview(() => previews.waveform(root));
  });
  command('openWaveform', async value => {
    const root = await rootFor(value), state = await readSimulation(root), tool = await getTools(root);
    await fs.access(state.wdb);
    const script = path.join(state.directory, 'open-waveform.tcl');
    await fs.writeFile(script, openWaveformTcl(state.wdb), 'utf8');
    const child = spawnTool(tool.vivado, ['-mode', 'gui', '-nolog', '-nojournal', '-source', portablePath(script)], state.directory);
    child.on('error', error => { void vscode.window.showErrorMessage(error.message); });
    child.stdout!.on('data', data => log(data.toString()));
    child.stderr!.on('data', data => log(data.toString()));
    child.stdin!.end();
    child.unref();
  });
  command('openVcd', async value => { const state = await readSimulation(await rootFor(value)); await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(state.vcd)); });
  command('program', async value => {
    const root = await rootFor(value);
    await saveProjectFiles(root);
    const project = await resolveProject(root), tool = await getTools(root), state = await readBuildState(root);
    if (!state?.bitstream || state.fingerprint !== await projectFingerprint(project, tool)) throw new Error('Generate a current bitstream before programming the device.');
    await fs.access(state.bitstream);
    await operation(root, 'Program FPGA', async signal => {
      const session = await sessionFor(root);
      let targets: string[];
      for (;;) {
        try { targets = await hardwareTargets(session, configuration(root).get('hw.serverUrl', 'localhost:3121'), signal); break; }
        catch (error) {
          if (!(error instanceof NoHardwareError)) throw error;
          if (await vscode.window.showWarningMessage(error.message, 'Retry') !== 'Retry') throw new CancelledError();
        }
      }
      const target = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: 'Hardware target' });
      if (!target) throw new CancelledError();
      const devices = await hardwareDevices(session, target, signal);
      const device = await vscode.window.showQuickPick(devices, { title: 'Device to program' });
      if (!device) throw new CancelledError();
      if (await vscode.window.showWarningMessage(`Program ${device} with ${path.basename(state.bitstream!)}?`, { modal: true }, 'Program') !== 'Program') throw new CancelledError();
      await programDevice(session, device, state.bitstream!, signal);
      void vscode.window.showInformationMessage(`Programmed ${device}.`);
    });
  });

  const watcher = vscode.workspace.createFileSystemWatcher('**/vivado-project.json');
  const ioConfigChanged = (uri: vscode.Uri) => { void refreshIoProject(path.dirname(uri.fsPath)); };
  const sourcesWatcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv,vh,svh,xdc,xci,bd}');
  const filesChanged = (uri: vscode.Uri) => {
    if (/[\\/]\.vivado[\\/]/.test(uri.fsPath)) return;
    tree.refresh();
    linter.refresh();
  };
  context.subscriptions.push(sourcesWatcher, sourcesWatcher.onDidCreate(filesChanged), sourcesWatcher.onDidDelete(filesChanged));
  context.subscriptions.push(watcher, watcher.onDidChange(() => { tree.refresh(); linter.refresh(); }), watcher.onDidCreate(() => tree.refresh()), watcher.onDidDelete(() => tree.refresh()),
    watcher.onDidChange(updateEditorContext), watcher.onDidCreate(updateEditorContext), watcher.onDidDelete(updateEditorContext),
    watcher.onDidChange(ioConfigChanged), watcher.onDidCreate(ioConfigChanged), watcher.onDidDelete(ioConfigChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(async event => { for (const folder of event.added) if (folder.uri.scheme === 'file') await detect(folder.uri.fsPath); tree.refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(() => { if (!running.size) idleStatus(); void updateEditorContext(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vivado.installPath') || event.affectsConfiguration('vivado.outputEncoding')) {
        for (const folder of vscode.workspace.workspaceFolders || []) if (folder.uri.scheme === 'file') void detect(folder.uri.fsPath).catch(error => log(String(error)));
      }
    }));
  for (const folder of vscode.workspace.workspaceFolders || []) if (folder.uri.scheme === 'file') await detect(folder.uri.fsPath);
  idleStatus();
  await updateEditorContext();
  await vscode.commands.executeCommand('setContext', 'vivado.running', false);
  tree.refresh();
  return { checkWorkspace: (root: string) => linter.checkWorkspace(root), getToolchain: (root: string) => tools.get(root) };
}

export function deactivate() {}
