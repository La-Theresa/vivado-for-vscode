import * as vscode from 'vscode';
import path from 'node:path';
import { Toolchain } from '../toolchain/detect';
import { CancelledError } from '../toolchain/process';
import { parseMessages, ToolMessage } from '../toolchain/messageParser';
import { CONFIG_FILE, isHdl, isHeader, ResolvedProject, resolveProject } from '../project/config';
import { createShadow, DocumentSnapshot, ShadowSnapshot } from './shadow';
import { compileFile, compileProject, elaborate, parallelMap } from './compiler';
import { clearWorkspaceDiagnostics, publishDiagnostics, publishWorkspaceDiagnostics } from './diagnostics';

export class Linter implements vscode.Disposable {
  readonly syntax = vscode.languages.createDiagnosticCollection('Vivado Syntax');
  readonly crossModule = vscode.languages.createDiagnosticCollection('Vivado Elaboration');
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private controllers = new Map<string, AbortController>();
  private checkOwners = new Map<string, string>();
  private subscriptions: vscode.Disposable[] = [];
  private stopped = false;
  private syntaxResults = new Map<string, { root: string; file: string; messages: ToolMessage[] }>();
  private activeChecks = new Map<string, number>();

  constructor(private tools: (root: string) => Toolchain | undefined, private log: (text: string) => void,
    private owner: (file: string) => string | undefined) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.changed(event.document, false); }),
      vscode.workspace.onDidSaveTextDocument(document => this.changed(document, true)),
      vscode.workspace.onDidOpenTextDocument(document => this.changed(document, false)),
      vscode.workspace.onDidCloseTextDocument(document => {
        this.cancel(`file:${document.uri.toString()}`);
        this.syntaxResults.delete(document.uri.toString());
        this.renderSyntax();
      }),
      vscode.workspace.onDidDeleteFiles(event => {
        for (const uri of event.files) { this.syntaxResults.delete(uri.toString()); this.crossModule.delete(uri); this.cancel(`file:${uri.toString()}`); }
        this.renderSyntax();
      }),
    );
  }

  refresh(): void {
    if (!this.stopped) for (const document of vscode.workspace.textDocuments) this.changed(document, false);
  }

  closeProject(root: string): void {
    this.cancel(`project:${root}`);
    for (const key of new Set([...this.timers.keys(), ...this.controllers.keys()])) {
      if (this.checkOwners.get(key) === root) this.cancel(key);
    }
    for (const [key, result] of this.syntaxResults) if (result.root === root) this.syntaxResults.delete(key);
    this.renderSyntax();
    clearWorkspaceDiagnostics(this.crossModule, root);
  }

  private renderSyntax(): void {
    this.syntax.clear();
    const messages = [...this.syntaxResults.values()].flatMap(result => result.messages.map(message => ({ ...message, file: message.file || result.file })));
    if (messages.length) publishDiagnostics(this.syntax, messages, '');
  }

  private root(document: vscode.TextDocument): string | undefined {
    return document.uri.scheme === 'file' ? this.owner(document.fileName) : undefined;
  }

  private cancel(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.checkOwners.delete(key);
  }

  private changed(document: vscode.TextDocument, saved: boolean): void {
    const root = this.root(document);
    if (!root || !vscode.workspace.isTrusted || (!isHdl(document.fileName) && !isHeader(document.fileName))) return;
    const settings = vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root));
    const projectKey = `project:${root}`;
    this.cancel(projectKey);
    clearWorkspaceDiagnostics(this.crossModule, root);
    const documents = isHdl(document.fileName) ? [document] : vscode.workspace.textDocuments.filter(d => this.root(d) === root && isHdl(d.fileName));
    for (const open of documents) {
      const key = `file:${open.uri.toString()}`;
      this.cancel(key);
      this.syntaxResults.delete(open.uri.toString());
      this.renderSyntax();
      if (saved || settings.get<boolean>('lint.onType', true)) {
        this.checkOwners.set(key, root);
        this.timers.set(key, setTimeout(() => { void this.checkFile(open).catch(error => this.handle(error)); }, saved ? 0 : settings.get<number>('lint.debounceMs', 500)));
      }
    }
    const mode = settings.get<string>('lint.elaborate', 'onIdle');
    if (mode === 'onIdle' || (saved && mode === 'onSave')) {
      this.timers.set(projectKey, setTimeout(() => { void this.checkElaboration(root).catch(error => this.handle(error)); }, saved ? 0 : 2000));
    }
  }

  private snapshots(root: string): DocumentSnapshot[] {
    return vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && this.root(d) === root && (isHdl(d.fileName) || isHeader(d.fileName)))
      .map(d => ({ file: d.fileName, text: d.getText() }));
  }

  private handle(error: unknown): void { if (!(error instanceof CancelledError)) this.log(`Live check: ${String(error)}\n`); }

  private async slot<T>(root: string, limit: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    while ((this.activeChecks.get(root) || 0) >= limit) {
      if (signal.aborted) throw new CancelledError();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (signal.aborted) throw new CancelledError();
    this.activeChecks.set(root, (this.activeChecks.get(root) || 0) + 1);
    try { return await action(); }
    finally { this.activeChecks.set(root, (this.activeChecks.get(root) || 1) - 1); }
  }

  async checkFile(document: vscode.TextDocument): Promise<void> {
    const root = this.root(document);
    if (!root || this.stopped) return;
    const tools = this.tools(root);
    if (!tools) return;
    const key = `file:${document.uri.toString()}`;
    this.cancel(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.checkOwners.set(key, root);
    const version = document.version;
    let project: ResolvedProject | undefined;
    try { project = await resolveProject(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const snapshot = await createShadow(root, [document.fileName], project?.includeDirs || [], this.snapshots(root));
    try {
      const settings = vscode.workspace.getConfiguration('vivado', document.uri);
      const cwd = path.join(snapshot.directory, 'syntax');
      const result = await this.slot(root, settings.get('lint.maxParallel', 2), controller.signal, () => compileFile(tools, { path: snapshot.file(document.fileName), includeDirs: snapshot.includes(document.fileName) }, {
        cwd, signal: controller.signal, defines: project?.config.defines, encoding: settings.get('outputEncoding', 'utf8'), timeoutMs: 30000,
      }));
      if (controller.signal.aborted || version !== document.version || this.stopped) return;
      const messages = parseMessages(result.output, cwd, snapshot.original);
      if (result.code !== 0 && !messages.some(m => m.severity === 'error')) messages.push({ severity: 'error', id: 'xvlog', message: result.output.slice(-2000) || 'xvlog failed.' });
      this.syntaxResults.set(document.uri.toString(), { root, file: document.fileName, messages });
      this.renderSyntax();
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      await snapshot.dispose();
    }
  }

  async checkWorkspace(root: string): Promise<void> {
    const project = await resolveProject(root);
    const files = [...new Set([...project.files.sources, ...project.files.simulation])].filter(isHdl);
    const concurrency = vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root)).get<number>('lint.maxParallel', 2);
    await parallelMap(files, concurrency, async file => {
      const document = await vscode.workspace.openTextDocument(file);
      await this.checkFile(document);
    });
    await this.checkElaboration(root);
  }

  async checkElaboration(root: string): Promise<void> {
    if (this.stopped) return;
    const tools = this.tools(root);
    if (!tools) return;
    const key = `project:${root}`;
    this.cancel(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    let snapshot: ShadowSnapshot | undefined;
    try {
      let project;
      try { project = await resolveProject(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const files = project.files.sources.filter(isHdl);
      if (!files.length || controller.signal.aborted || this.stopped) return;
      snapshot = await createShadow(root, files, project.includeDirs, this.snapshots(root));
      const shadow = snapshot;
      const cwd = path.join(snapshot.directory, 'elaboration');
      const settings = vscode.workspace.getConfiguration('vivado', vscode.Uri.file(root));
      const options = { cwd, signal: controller.signal, defines: project.config.defines, encoding: settings.get('outputEncoding', 'utf8'), timeoutMs: 60000 };
      const compiled = await compileProject(tools, files.map(file => ({ path: shadow.file(file), includeDirs: shadow.includes(file) })), options);
      let messages: ToolMessage[] = parseMessages(compiled.output, cwd, snapshot.original);
      if (compiled.code === 0) {
        const result = await elaborate(tools, project.config.top, { ...options, timescale: settings.get('sim.defaultTimescale', '1ns/1ps') });
        messages = parseMessages(result.output, cwd, snapshot.original);
        if (result.code && !messages.some(m => m.severity === 'error')) messages.push({ severity: 'error', id: 'xelab', message: result.output.slice(-2000) || 'Elaboration failed.' });
      }
      if (!controller.signal.aborted && !this.stopped) {
        clearWorkspaceDiagnostics(this.crossModule, root);
        publishWorkspaceDiagnostics(this.crossModule, root, messages, path.join(root, CONFIG_FILE));
      }
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      await snapshot?.dispose();
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const key of new Set([...this.timers.keys(), ...this.controllers.keys()])) this.cancel(key);
    this.subscriptions.forEach(d => d.dispose());
    this.syntax.dispose();
    this.crossModule.dispose();
  }
}
