import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readReports } from '../build/reports';
import { readBuildState } from '../build/builder';

export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }

export async function showReports(root: string): Promise<void> {
  const report = await readReports(root);
  const state = await readBuildState(root);
  const panel = vscode.window.createWebviewPanel('vivado.reports', 'Vivado Reports', vscode.ViewColumn.Beside, { enableScripts: false, localResourceRoots: [] });
  const nonce = randomUUID();
  const metrics = ['WNS', 'TNS', 'WHS', 'THS'].map(name => `<div><dt>${name}</dt><dd>${escapeHtml(report.metrics[`STATS.${name}`] || 'N/A')} <small>ns</small></dd></div>`).join('');
  const rows = report.resources.map(row => `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${escapeHtml(row.used)}</td><td>${escapeHtml(row.available)}</td><td>${escapeHtml(row.percent)}</td></tr>`).join('');
  panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;letter-spacing:0}main{max-width:960px;margin:auto}h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin-top:28px}p,small,dt{color:var(--vscode-descriptionForeground)}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:20px;padding:16px 0;border-block:1px solid var(--vscode-panel-border)}dd{margin:8px 0 0;font-size:20px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border);text-align:right}th:first-child{text-align:left}thead{background:var(--vscode-editor-inactiveSelectionBackground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px var(--vscode-editor-font-family)}.scroll{overflow:auto}p{overflow-wrap:anywhere}
</style></head><body><main><h1>Vivado Reports</h1><p>${escapeHtml(root)}</p><p>${state ? escapeHtml(`${state.stage} / ${state.completedAt}`) : 'No successful build state. Reports below may be from an earlier run.'}</p><h2>Timing</h2><dl>${metrics}</dl><h2>Utilization</h2><div class="scroll"><table><thead><tr><th>Resource</th><th>Used</th><th>Available</th><th>Utilization %</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No report available</td></tr>'}</tbody></table></div><h2>Design Rule Checks</h2><pre>${escapeHtml(report.drc || 'No report available')}</pre></main></body></html>`;
}
