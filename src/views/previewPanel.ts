import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSimulation } from '../sim/simulator';
import { readWaveform } from '../sim/waveform';
import { parseSchematic } from '../build/schematic';
import { IoData, PreviewData } from './previewModel';
import { previewHtml } from './previewHtml';

interface PreviewEntry { panel: vscode.WebviewPanel; data?: PreviewData; message?: string }

export class PreviewPanels implements vscode.Disposable {
  private panels = new Map<string, PreviewEntry>();
  private waveformRequests = new Map<string, symbol>();
  constructor(private readonly extensionUri: vscode.Uri, private readonly ioActions: {
    open(root: string, port?: string): Promise<void>;
    reload(root: string, dirty: boolean): Promise<IoData | undefined>;
    save(root: string, data: IoData, entries: unknown): Promise<IoData | undefined>;
  }) {}

  revealIo(root: string, port?: string): boolean {
    const existing = this.panels.get(`${root}:ioPlanning`);
    if (!existing) return false;
    existing.panel.reveal(existing.panel.viewColumn, false);
    if (port) void existing.panel.webview.postMessage({ type: 'ioFocus', port });
    return true;
  }

  checkIoProject(root: string, project?: { part: string; top: string }): void {
    const existing = this.panels.get(`${root}:ioPlanning`);
    if (!existing || existing.data?.kind !== 'ioPlanning') return;
    if (project && existing.data.part.toLowerCase() === project.part.toLowerCase() && existing.data.title === project.top) return;
    existing.data.stale = 'Project part or top changed. Run Synthesize, then Reload I/O Planning.';
    void existing.panel.webview.postMessage({ type: 'ioStale', error: existing.data.stale });
  }

  io(root: string, data: IoData): void { this.show(root, data); }

  resetWaveform(root: string, message: string): void {
    this.waveformRequests.delete(root);
    const entry = this.panels.get(`${root}:waveform`);
    if (!entry) return;
    entry.data = undefined;
    entry.message = message;
    entry.panel.title = 'Waveform';
    void entry.panel.webview.postMessage({ type: 'status', message });
  }

  async waveform(root: string): Promise<void> {
    const request = Symbol();
    this.waveformRequests.set(root, request);
    try {
      const state = await readSimulation(root).catch(() => { throw new Error('Run a simulation successfully before opening the waveform preview.'); });
      const data = await readWaveform(state.vcd, path.join(this.extensionUri.fsPath, 'dist', 'vivado_vcd_parser.wasm'));
      data.title = state.top;
      if (this.waveformRequests.get(root) === request) this.show(root, data);
    } catch (error) {
      if (this.waveformRequests.get(root) === request) throw error;
    } finally {
      if (this.waveformRequests.get(root) === request) this.waveformRequests.delete(root);
    }
  }

  async schematic(root: string, stale: boolean): Promise<void> {
    const file = path.join(root, '.vivado', 'reports', 'schematic.xml');
    const stat = await fs.stat(file).catch(() => { throw new Error('Run Synthesize to generate a schematic preview.'); });
    if (stat.size > 8 * 1024 * 1024) throw new Error('Netlist exceeds the preview size limit. Use Vivado GUI.');
    const data = parseSchematic(await fs.readFile(file, 'utf8'), file);
    data.stale = stale;
    this.show(root, data);
  }

  private show(root: string, data: PreviewData): void {
    const title = `${data.kind === 'waveform' ? 'Waveform' : data.kind === 'ioPlanning' ? 'I/O Planning' : 'Schematic'}: ${data.title}`;
    const key = `${root}:${data.kind}`, existing = this.panels.get(key);
    if (existing) {
      existing.data = data;
      existing.message = undefined;
      existing.panel.title = title;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, data.kind !== 'ioPlanning');
      void existing.panel.webview.postMessage({ type: 'data', data });
      return;
    }
    const assets = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const side = [...this.panels.entries()].find(([key]) => key.startsWith(`${root}:`))?.[1].panel.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(`vivado.${data.kind}`, title,
      { viewColumn: side, preserveFocus: data.kind !== 'ioPlanning' }, { enableScripts: true, localResourceRoots: [assets], retainContextWhenHidden: true });
    const entry: PreviewEntry = { panel, data };
    this.panels.set(key, entry);
    panel.webview.html = previewHtml(
      panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'preview.js')).toString(),
      panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'preview.css')).toString(),
      panel.webview.cspSource, randomUUID(),
    );
    let busy = false;
    const receiver = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') void panel.webview.postMessage(entry.data ? { type: 'data', data: entry.data } : { type: 'status', message: entry.message });
      if (message?.type === 'external' && entry.data) {
        void vscode.commands.executeCommand(entry.data.kind === 'waveform' ? 'vivado.openWaveform' : 'vivado.openGui', vscode.Uri.file(root));
      }
      if (busy) return;
      if (message?.type === 'planIo' && entry.data?.kind === 'schematic') {
        const port = message.port === undefined ? undefined : entry.data.nodes.find(node => node.port && node.name === message.port)?.name;
        if (message.port !== undefined && !port) return;
        busy = true;
        try { await this.ioActions.open(root, port); }
        catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
        finally { busy = false; }
      }
      if ((message?.type === 'ioSave' || message?.type === 'ioReload') && entry.data?.kind === 'ioPlanning') {
        busy = true;
        try {
          if (message.type === 'ioSave' && entry.data.stale) throw new Error(entry.data.stale);
          if (message.type === 'ioSave' && message.revision !== entry.data.revision) throw new Error('The I/O view is outdated. Reload before saving.');
          const next = message.type === 'ioSave' ? await this.ioActions.save(root, entry.data, message.assignments) : await this.ioActions.reload(root, message.dirty === true);
          if (next) { entry.data = next; await panel.webview.postMessage({ type: 'data', data: next }); }
          else await panel.webview.postMessage({ type: 'ioResult', cancelled: true });
        } catch (error) { await panel.webview.postMessage({ type: 'ioResult', error: error instanceof Error ? error.message : String(error) }); }
        finally { busy = false; }
      }
    });
    panel.onDidDispose(() => { receiver.dispose(); this.panels.delete(key); });
  }

  closeProject(root: string): void {
    this.waveformRequests.delete(root);
    for (const [key, entry] of [...this.panels]) if (key.startsWith(`${root}:`)) entry.panel.dispose();
  }

  dispose(): void { this.waveformRequests.clear(); for (const entry of [...this.panels.values()]) entry.panel.dispose(); }
}
