import path from 'node:path';

export interface ToolMessage {
  severity: 'error' | 'warning';
  id: string;
  message: string;
  file?: string;
  line?: number;
}

export function normalizeToolPath(file: string, cwd?: string): string {
  let result = file.trim().replace(/^"(.*)"$/, '$1').replace(/\\/g, '/');
  while (/^([A-Za-z]):\1:/i.test(result)) result = result.slice(2);
  if (cwd && !path.isAbsolute(result) && !/^[A-Za-z]:\//.test(result)) result = path.resolve(cwd, result);
  return result.replace(/\\/g, '/');
}

export function pathKey(file: string): string {
  const normalized = normalizeToolPath(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function parseMessages(output: string, cwd?: string, map?: (file: string) => string): ToolMessage[] {
  const messages: ToolMessage[] = [];
  let continuation: ToolMessage | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(ERROR|CRITICAL WARNING|WARNING):\s*\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      let text = match[3];
      let start = -1, depth = 0;
      if (text.trimEnd().endsWith(']')) {
        for (let index = text.trimEnd().length - 1; index >= 0; index--) {
          if (text[index] === ']') depth++;
          if (text[index] === '[' && --depth === 0) { start = index; break; }
        }
      }
      const location = start < 0 ? null : text.slice(start).match(/^\[(.+?):(\d+)(?::\d+)?\]\s*$/);
      let file: string | undefined;
      if (location) {
        file = normalizeToolPath(location[1], cwd);
        file = map ? map(file) : file;
        text = text.slice(0, start).trimEnd();
      }
      messages.push({
        severity: match[1] === 'ERROR' ? 'error' : 'warning',
        id: match[2], message: text, file,
        line: location ? Math.max(0, Number(location[2]) - 1) : undefined,
      });
      continuation = messages[messages.length - 1];
    } else if (continuation && /^(\s*Resolution:|\s{2,}\S)/.test(line) && line.trim()) {
      continuation.message += `\n${line.trim()}`;
    } else continuation = undefined;
  }
  return messages;
}
