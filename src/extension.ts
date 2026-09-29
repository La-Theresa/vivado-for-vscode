import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectToolchain, Toolchain } from './toolchain/detect';
import { CancelledError, requireSuccess, spawnTool } from './toolchain/process';
import { TclSession } from './toolchain/tclSession';
import { CONFIG_FILE, FileGroup, discoverModules, portablePath, readConfig, resolveProject, writeConfig } from './project/config';
import { createProjectFolder, createProjectSourceFolders } from './project/create';
import { createProjectFile, newFileDirectory } from './project/files';
import { isInside, ProjectIndex } from './project/projects';
import { consoleShell, consoleStartupTcl } from './toolchain/console';
import { importXpr } from './project/importXpr';
import { installedParts } from './project/parts';
import { syncProjectTcl } from './project/sync';
import { Linter } from './lint/linter';
import { clearWorkspaceDiagnostics, publishWorkspaceDiagnostics } from './lint/diagnostics';
import { BuildStage, buildProject, projectFingerprint, readBuildState, runBatch } from './build/builder';
import { clearSimulationCache, openWaveformTcl, readSimulation, simulate, simulationTops } from './sim/simulator';
import { hardwareDevices, hardwareTargets, NoHardwareError, programDevice, readHardwareConnection } from './hw/hardware';
import { ProjectNode, ProjectTree } from './views/projectTree';
import { showReports } from './views/reportsPanel';
import { PreviewPanels } from './views/previewPanel';
import { simulationRunTime } from './sim/runtime';
import { readIoPlan, saveIoPlan } from './io/planner';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Vivado');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const projects = new ProjectIndex(context.workspaceState.get<string[]>('closedProjects', []));
  const extraRoots = new Set(context.workspaceState.get<string[]>('openedProjects', []));
  const tree = new ProjectTree(() => projects.roots);
  const buildDiagnostics = vscode.languages.createDiagnosticCollection('Vivado Build');
  const simDiagnostics = vscode.languages.createDiagnosticCollection('Vivado Simulation');
  const tools = new Map<string, Toolchain>();
  const sessions = new Map<string, TclSession>();
  const running = new Map<string, AbortController>();
  const operationDone = new Map<string, Promise<void>>();
  const consoles = new Map<string, vscode.Terminal>();
  const simulationTerminals = new Map<string, vscode.Terminal>();
  const externalWatchers = new Map<string, vscode.Disposable>();
  const closing = new Set<string>();
  let projectRefresh: Promise<void> | undefined;
  let refreshAgain = false;
  const log = (text: string) => output.append(text);
  const linter = new Linter(root => closing.has(root) ? undefined : tools.get(root), log,
    file => projects.owners(file).find(root => !closing.has(root)));
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
    { dispose: () => {
      for (const controller of running.values()) controller.abort();
      for (const session of sessions.values()) void session.dispose();
      for (const terminal of consoles.values()) terminal.dispose();
      for (const terminal of simulationTerminals.values()) terminal.dispose();
      for (const watcher of externalWatchers.values()) watcher.dispose();
    } });

  const configuration = (root: string) => vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root));
  const updateEditorContext = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const hasProject = uri?.scheme === 'file' && projects.owners(uri.fsPath).length > 0;
    await vscode.commands.executeCommand('setContext', 'vivado.editorProject', !!hasProject);
    await vscode.commands.executeCommand('setContext', 'vivado.hasProject', projects.roots.length > 0);
  };
  const idleStatus = () => {
    if (!projects.roots.length) {
      status.text = '$(circuit-board) Vivado: No open project';
      status.tooltip = 'Open a Vivado project';
      status.command = 'vivado.openProject';
      status.show();
      return;
    }
    const active = vscode.window.activeTextEditor && projects.owners(vscode.window.activeTextEditor.document.uri.fsPath)[0];
    const tool = (active && tools.get(active)) || tools.values().next().value;
    status.text = tool ? `$(circuit-board) Vivado ${tool.version}` : '$(warning) Vivado not found';
    status.tooltip = tool?.root || 'Select a Vivado installation';
    status.command = 'vivado.detect';
    status.show();
  };

  async function rootFor(value?: unknown, requireProject = true): Promise<string> {
    if (value instanceof ProjectNode) {
      if (requireProject && !projects.has(value.root)) throw new Error('This project is closed. Use Vivado: Open Project.');
      return value.root;
    }
    const uri = value instanceof vscode.Uri ? value : vscode.window.activeTextEditor?.document.uri;
    if (requireProject) {
      const owners = uri?.scheme === 'file' ? projects.owners(uri.fsPath) : [];
      if (value instanceof vscode.Uri && !owners.length && projects.closedRoots.some(root => isInside(root, value.fsPath))) {
        throw new Error('This project is closed. Use Vivado: Open Project.');
      }
      const roots = owners.length ? owners : projects.roots;
      if (!roots.length) throw new Error('No open Vivado project. Use Vivado: Open Project, New Project or Import XPR Project.');
      if (roots.length === 1) return roots[0];
      const selected = await vscode.window.showQuickPick(roots.map(root => ({ label: path.basename(root), description: root, root })), { title: 'Vivado project' });
      if (!selected) throw new CancelledError();
      return selected.root;
    }
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri.fsPath;
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
    if (!folders.length) throw new Error('Open a local workspace folder first.');
    if (folders.length === 1) return folders[0].uri.fsPath;
    const selected = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })), { title: 'Vivado workspace' });
    if (!selected) throw new CancelledError();
    return selected.root;
  }

  function refreshProjects(): Promise<void> {
    if (projectRefresh) { refreshAgain = true; return projectRefresh; }
    projectRefresh = (async () => {
      do { refreshAgain = false; await refreshProjectsNow(); } while (refreshAgain);
    })().finally(() => { projectRefresh = undefined; });
    return projectRefresh;
  }

  async function refreshProjectsNow(): Promise<void> {
    const previous = projects.roots;
    await projects.refresh((vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath), [...extraRoots]);
    for (const root of previous) if (!projects.has(root)) {
      running.get(root)?.abort();
      linter.closeProject(root);
      consoles.get(root)?.dispose();
      consoles.delete(root);
      closeSimulationTerminal(root);
      externalWatchers.get(root)?.dispose();
      externalWatchers.delete(root);
      previews.closeProject(root);
      await sessions.get(root)?.dispose();
      sessions.delete(root);
      tools.delete(root);
      clearWorkspaceDiagnostics(buildDiagnostics, root);
      clearWorkspaceDiagnostics(simDiagnostics, root);
    }
    await updateEditorContext();
    tree.refresh();
    for (const root of projects.roots) {
      if (externalWatchers.has(root) || vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{json,v,sv,vh,svh,xdc,xci,bd}'));
      const configChanged = (uri: vscode.Uri) => {
        if (path.basename(uri.fsPath) === CONFIG_FILE) {
          void refreshIoProject(root);
          void refreshProjects().catch(error => log(String(error) + '\n'));
        }
      };
      externalWatchers.set(root, vscode.Disposable.from(watcher, watcher.onDidChange(configChanged),
        watcher.onDidCreate(filesChanged), watcher.onDidDelete(filesChanged)));
    }
    for (const root of projects.roots) if (!tools.has(root) && !closing.has(root)) await detect(root).catch(error => log(String(error) + '\n'));
    linter.refresh();
  }

  async function openProject(root: string): Promise<void> {
    await readConfig(root);
    projects.open(root);
    extraRoots.add(root);
    await context.workspaceState.update('closedProjects', projects.closedRoots);
    await context.workspaceState.update('openedProjects', [...extraRoots]);
    await refreshProjects();
  }

  async function closeConsole(root: string): Promise<void> {
    const terminal = consoles.get(root);
    if (!terminal) return;
    await new Promise<void>(resolve => {
      const listener = vscode.window.onDidCloseTerminal(closed => {
        if (closed !== terminal) return;
        listener.dispose();
        consoles.delete(root);
        resolve();
      });
      terminal.dispose();
    });
  }

  function closeSimulationTerminal(root: string): void {
    simulationTerminals.get(root)?.dispose();
    simulationTerminals.delete(root);
  }

  async function closeProject(root: string): Promise<void> {
    closing.add(root);
    try {
      running.get(root)?.abort();
      await operationDone.get(root);
      linter.closeProject(root);
      await closeConsole(root);
      closeSimulationTerminal(root);
      await sessions.get(root)?.dispose();
      sessions.delete(root);
      previews.closeProject(root);
      clearWorkspaceDiagnostics(buildDiagnostics, root);
      clearWorkspaceDiagnostics(simDiagnostics, root);
      tools.delete(root);
      projects.close(root);
      externalWatchers.get(root)?.dispose();
      externalWatchers.delete(root);
      extraRoots.delete(root);
      await context.workspaceState.update('closedProjects', projects.closedRoots);
      await context.workspaceState.update('openedProjects', [...extraRoots]);
      await updateEditorContext();
      idleStatus();
      tree.refresh();
    } finally { closing.delete(root); }
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
      await configuration(root).update('installPath', setting,
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global);
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
    if (consoles.has(root)) {
      if (await vscode.window.showWarningMessage(`Close the Tcl Console before ${title}? Save any Tcl changes you need to keep; automated runs synchronize from vivado-project.json.`, { modal: true }, 'Close Console and Continue') !== 'Close Console and Continue') throw new CancelledError();
      await closeConsole(root);
    }
    if (closing.has(root)) throw new CancelledError();
    if (running.has(root)) throw new Error('A Vivado operation is already running for this workspace. Cancel it or wait for completion.');
    const controller = new AbortController();
    running.set(root, controller);
    let finish!: () => void;
    operationDone.set(root, new Promise<void>(resolve => { finish = resolve; }));
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
      operationDone.delete(root);
      finish();
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
      if (project.config.projectDirectory === '.') await createProjectSourceFolders(project);
    });
  }

  async function saveProjectFiles(root: string): Promise<void> {
    const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file'
      && (projects.owners(document.uri.fsPath).includes(root) || isInside(root, document.uri.fsPath)));
    if (dirty.length && await vscode.window.showWarningMessage('Save modified workspace files before running Vivado?', { modal: true }, 'Save and Continue') !== 'Save and Continue') throw new CancelledError();
    for (const document of dirty) if (!await document.save()) throw new Error(`Could not save ${document.fileName}`);
  }

  command('detect', async value => { const root = await rootFor(value, false); await detect(root, true); });
  command('refresh', refreshProjects);
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
    const name = await vscode.window.showInputBox({ title: 'Project name', value: 'fpga_project', validateInput: value => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? undefined : 'Use letters, numbers, underscores and hyphens.' });
    if (!name) return;
    const location = await vscode.window.showOpenDialog({
      title: `Project location: create the ${name} subfolder here`,
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: value instanceof ProjectNode ? vscode.Uri.file(path.dirname(value.root)) : vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!location?.length) return;
    const parent = location[0].fsPath;
    const part = await selectPart(parent);
    if (!part) return;
    const top = await vscode.window.showInputBox({ title: 'Top module', value: 'top', validateInput: value => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) ? undefined : 'Enter a Verilog module identifier.' });
    if (!top) return;
    const root = await createProjectFolder(parent, name, part, top);
    const tool = tools.get(parent);
    if (tool) tools.set(root, tool);
    await synchronize(root);
    await openProject(root);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, CONFIG_FILE)));
  });
  command('openProject', async value => {
    const selected = value instanceof vscode.Uri ? value : (await vscode.window.showOpenDialog({
      title: 'Open vivado-project.json', canSelectMany: false, canSelectFiles: true,
      filters: { 'Vivado project configuration': ['json'] },
    }))?.[0];
    if (!selected) return;
    const stat = await fs.stat(selected.fsPath);
    if (!stat.isDirectory() && path.basename(selected.fsPath) !== CONFIG_FILE) throw new Error(`Select ${CONFIG_FILE}. To open an XPR, use Vivado: Import XPR Project.`);
    const root = stat.isDirectory() ? selected.fsPath : path.dirname(selected.fsPath);
    await openProject(root);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, CONFIG_FILE)));
  });
  command('closeProject', async value => {
    const root = await rootFor(value);
    if (await vscode.window.showWarningMessage(`Close ${path.basename(root)}? Running tasks, Tcl Console and previews will close. Unsaved I/O table edits will be discarded; source files and project files will not be deleted.`, { modal: true }, 'Close Project') !== 'Close Project') return;
    await closeProject(root);
  });
  command('importProject', async value => {
    const root = await rootFor(value, false);
    if (!await allowOverwrite(root)) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Vivado Project': ['xpr'] } });
    if (!files?.length) return;
    const imported = importXpr(await fs.readFile(files[0].fsPath, 'utf8'), files[0].fsPath, root);
    await writeConfig(root, imported.config);
    for (const warning of imported.warnings) log(warning + '\n');
    await synchronize(root);
    await openProject(root);
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
  const fileGroups = [{ label: 'Design Sources', group: 'sources' }, { label: 'Constraints', group: 'constraints' }, { label: 'Simulation Sources', group: 'simulation' }] as const;
  command('createFile', async (value, requestedGroup?: FileGroup, destination?: vscode.Uri) => {
    const root = await rootFor(value);
    if (running.has(root)) throw new Error('Wait for the current Vivado operation to finish before creating a file.');
    await saveProjectFiles(root);
    const group = requestedGroup ?? (value instanceof ProjectNode ? value.group : undefined)
      ?? (await vscode.window.showQuickPick(fileGroups, { title: 'New project file' }))?.group;
    if (!group) return;
    if (!fileGroups.some(choice => choice.group === group)) throw new Error('Invalid project file category.');
    const project = await resolveProject(root);
    const name = group === 'sources' ? `${project.config.top}.v` : group === 'simulation' ? `${project.config.simulationTop || `tb_${project.config.top}`}.v` : `${project.config.name}.xdc`;
    const file = destination ?? await vscode.window.showSaveDialog({
      title: `New ${fileGroups.find(choice => choice.group === group)!.label} File`,
      defaultUri: vscode.Uri.file(path.join(newFileDirectory(project, group), name)),
      filters: group === 'constraints' ? { 'Xilinx Constraints': ['xdc'] } : { Verilog: ['v'], SystemVerilog: ['sv'] },
      saveLabel: 'Create File',
    });
    if (!file) return;
    if (!(file instanceof vscode.Uri) || file.scheme !== 'file') throw new Error('Select a local file inside the project.');
    if (!projects.has(root) || closing.has(root)) throw new CancelledError();
    if (running.has(root)) throw new Error('Wait for the current Vivado operation to finish before creating a file.');
    if (isInside(path.join(project.projectDir, `${project.config.name}.srcs`), file.fsPath)
      && !await fs.access(project.xpr).then(() => true, () => false)) await synchronize(root);
    if (!projects.has(root) || closing.has(root)) throw new CancelledError();
    const created = await createProjectFile(root, group, file.fsPath, tools.get(root)?.version);
    await refreshProjects();
    await vscode.window.showTextDocument(vscode.Uri.file(created));
    return vscode.Uri.file(created);
  });
  command('addFile', async value => {
    const root = await rootFor(value);
    const group = value instanceof ProjectNode && value.group ? value.group : (await vscode.window.showQuickPick(fileGroups, { title: 'File category' }))?.group;
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
    if (stage === 'synthesis' && projects.has(root) && !closing.has(root)) await autoPreview(() => showSchematic(root));
    return result;
  }
  command('synthesize', value => runBuild('synthesis', value));
  command('implement', value => runBuild('implementation', value));
  command('bitstream', value => runBuild('bitstream', value));
  command('buildAll', value => runBuild('bitstream', value, true));

  command('openTclConsole', async value => {
    const root = await rootFor(value);
    const existing = consoles.get(root);
    if (existing) { existing.show(); return existing; }
    await saveProjectFiles(root);
    await synchronize(root);
    const project = await resolveProject(root), tool = await getTools(root);
    return operation(root, 'Open Tcl Console', async signal => {
      const session = sessions.get(root);
      const hardware = session && await readHardwareConnection(session, signal);
      const script = path.join(root, '.vivado', 'scripts', 'console.tcl');
      const shell = consoleShell(tool.vivado, script);
      await fs.writeFile(script, consoleStartupTcl(project, hardware), 'utf8');
      if (signal.aborted || !projects.has(root) || closing.has(root)) throw new CancelledError();
      // Release the background client's target before the interactive process reconnects.
      if (hardware) await session!.execute('close_hw', signal, 60000);
      if (signal.aborted || !projects.has(root) || closing.has(root)) throw new CancelledError();
      const terminal = vscode.window.createTerminal({
        name: `Vivado Tcl: ${project.config.name}`, cwd: root, ...shell,
      });
      consoles.set(root, terminal);
      terminal.show();
      return terminal;
    });
  });
  command('closeTclConsole', async value => closeConsole(await rootFor(value)));

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
    return operation(root, 'Vivado simulation', async signal => {
      closeSimulationTerminal(root);
      clearWorkspaceDiagnostics(simDiagnostics, root);
      previews.resetWaveform(root, 'Running simulation...');
      const write = new vscode.EventEmitter<string>();
      let ready = false, pending = '';
      const owner = running.get(root);
      let cancelSimulation = () => owner?.abort();
      const terminal = vscode.window.createTerminal({ name: `Vivado: ${top}`, pty: {
        onDidWrite: write.event, open: () => { ready = true; write.fire(pending); pending = ''; },
        close: () => { cancelSimulation(); write.dispose(); },
      } });
      simulationTerminals.set(root, terminal);
      terminal.show(true);
      log(`Simulation top: ${top}; duration: ${runTime}${project.config.simulationRunTime ? ' (vivado-project.json)' : ' (VS Code setting/default)'}\n`);
      try {
        const state = await simulate(tool, project, top, {
          cwd: root, signal, runTime, timescale: settings.get('sim.defaultTimescale', '1ns/1ps'), encoding: settings.get('outputEncoding', 'utf8'),
          onOutput: text => { log(text); const formatted = text.replace(/\r?\n/g, '\r\n'); if (ready) write.fire(formatted); else pending = (pending + formatted).slice(-8 * 1024 * 1024); },
          onMessages: messages => publishWorkspaceDiagnostics(simDiagnostics, root, messages, path.join(root, CONFIG_FILE)),
        });
        void vscode.window.showInformationMessage('Simulation complete. WDB and VCD are available.');
        if (projects.has(root) && !closing.has(root)) await autoPreview(() => previews.waveform(root));
        return state;
      } catch (error) {
        previews.resetWaveform(root, error instanceof CancelledError ? 'Simulation cancelled. No current results.' : 'Simulation failed. No current results.');
        throw error;
      } finally { cancelSimulation = () => {}; }
    });
  });
  command('clearSimulationCache', async value => {
    const root = await rootFor(value);
    await operation(root, 'Clear simulation cache', async signal => {
      if (signal.aborted) throw new CancelledError();
      previews.resetWaveform(root, 'No current simulation results.');
      await clearSimulationCache(root);
      closeSimulationTerminal(root);
      clearWorkspaceDiagnostics(simDiagnostics, root);
      previews.resetWaveform(root, 'Simulation cache cleared.');
    });
    void vscode.window.showInformationMessage('Simulation cache and previous waveforms cleared.');
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
    if (/[\\/](?:\.vivado|[^\\/]+\.(?:runs|cache|sim|hw|gen|ip_user_files))[\\/]/.test(uri.fsPath)) return;
    void refreshProjects().catch(error => log(String(error) + '\n'));
  };
  context.subscriptions.push(sourcesWatcher, sourcesWatcher.onDidCreate(filesChanged), sourcesWatcher.onDidDelete(filesChanged));
  const projectsChanged = () => { void refreshProjects().catch(error => log(String(error) + '\n')); };
  context.subscriptions.push(watcher, watcher.onDidChange(projectsChanged), watcher.onDidCreate(projectsChanged), watcher.onDidDelete(projectsChanged),
    watcher.onDidChange(ioConfigChanged), watcher.onDidCreate(ioConfigChanged), watcher.onDidDelete(ioConfigChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(projectsChanged),
    vscode.window.onDidCloseTerminal(terminal => {
      for (const [root, current] of consoles) if (current === terminal) consoles.delete(root);
      for (const [root, current] of simulationTerminals) if (current === terminal) simulationTerminals.delete(root);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => { if (!running.size) idleStatus(); void updateEditorContext(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vivado.installPath') || event.affectsConfiguration('vivado.outputEncoding')) {
        for (const root of projects.roots) void detect(root).catch(error => log(String(error)));
      }
    }));
  await refreshProjects();
  idleStatus();
  await updateEditorContext();
  await vscode.commands.executeCommand('setContext', 'vivado.running', false);
  tree.refresh();
  return {
    checkWorkspace: (root: string) => linter.checkWorkspace(root), getToolchain: (root: string) => tools.get(root),
    projectRoots: () => projects.roots, projectOwners: (file: string) => projects.owners(file), closeProject, refreshProjects,
  };
}

export function deactivate() {}
