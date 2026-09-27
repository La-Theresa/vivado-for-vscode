import * as vscode from 'vscode';
import { ToolMessage, pathKey } from '../toolchain/messageParser';

const owned = new WeakMap<vscode.DiagnosticCollection, Map<string, { messages: ToolMessage[]; fallback: string }>>();

export function publishWorkspaceDiagnostics(collection: vscode.DiagnosticCollection, root: string, messages: ToolMessage[], fallback: string): void {
  const projects = owned.get(collection) || new Map();
  projects.set(pathKey(root), { messages, fallback });
  owned.set(collection, projects);
  renderOwned(collection, projects);
}

function renderOwned(collection: vscode.DiagnosticCollection, projects: Map<string, { messages: ToolMessage[]; fallback: string }>): void {
  collection.clear();
  const messages = [...projects.values()].flatMap(project => project.messages.map(message => ({ ...message, file: message.file || project.fallback })));
  if (messages.length) publishDiagnostics(collection, messages, '');
}

export function publishDiagnostics(collection: vscode.DiagnosticCollection, messages: ToolMessage[], fallback: string, clearFiles: string[] = []): void {
  const grouped = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
  for (const file of clearFiles) grouped.set(pathKey(file), { uri: vscode.Uri.file(file), items: [] });
  for (const message of messages) {
    const file = message.file || fallback;
    const key = pathKey(file);
    const entry = grouped.get(key) || { uri: vscode.Uri.file(file), items: [] };
    const line = message.line || 0;
    const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), message.message,
      message.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    diagnostic.source = collection.name;
    diagnostic.code = message.id;
    if (!entry.items.some(d => d.code === diagnostic.code && d.range.start.line === line && d.message === diagnostic.message)) entry.items.push(diagnostic);
    grouped.set(key, entry);
  }
  collection.set([...grouped.values()].map(entry => [entry.uri, entry.items]));
}

export function clearWorkspaceDiagnostics(collection: vscode.DiagnosticCollection, root: string): void {
  const projects = owned.get(collection);
  if (projects) { projects.delete(pathKey(root)); renderOwned(collection, projects); return; }
  const prefix = pathKey(root).replace(/\/$/, '') + '/';
  collection.forEach(uri => { if (pathKey(uri.fsPath).startsWith(prefix)) collection.delete(uri); });
}
