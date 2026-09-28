import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { CONFIG_FILE, PROJECT_IGNORES, ResolvedProject, resolveProject } from './config';
import { pathKey } from '../toolchain/messageParser';

export function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export class ProjectIndex {
  private entries = new Map<string, { root: string; project?: ResolvedProject }>();
  private closed: Set<string>;
  private generation = 0;

  constructor(closed: string[] = []) { this.closed = new Set(closed.map(pathKey)); }
  get roots(): string[] { return [...this.entries.values()].map(entry => entry.root); }
  get closedRoots(): string[] { return [...this.closed]; }
  has(root: string): boolean { return this.entries.has(pathKey(root)); }
  open(root: string): void { this.closed.delete(pathKey(root)); }
  close(root: string): void {
    this.generation++;
    this.closed.add(pathKey(root));
    this.entries.delete(pathKey(root));
  }

  async refresh(folders: string[], extraRoots: string[] = []): Promise<void> {
    const generation = ++this.generation;
    const candidates = [...extraRoots];
    for (const folder of folders) {
      const files = await fg(`**/${CONFIG_FILE}`, {
        cwd: folder, absolute: true, onlyFiles: true, followSymbolicLinks: false,
        ignore: [...PROJECT_IGNORES, '**/.test-work/**', '**/.vscode-test/**'],
      });
      candidates.push(...files.map(file => path.dirname(file)));
    }
    const entries = new Map<string, { root: string; project?: ResolvedProject }>();
    for (const candidate of candidates) {
      const root = path.resolve(candidate), key = pathKey(root);
      if (entries.has(key) || this.closed.has(key)) continue;
      if (!await fs.access(path.join(root, CONFIG_FILE)).then(() => true, () => false)) continue;
      entries.set(key, { root, project: await resolveProject(root).catch(() => undefined) });
    }
    if (generation === this.generation) this.entries = entries;
  }

  owners(file: string): string[] {
    const key = pathKey(file);
    const entries = [...this.entries.values()].sort((a, b) => b.root.length - a.root.length);
    const exact = entries.filter(entry => entry.project && Object.values(entry.project.files).flat().some(source => pathKey(source) === key));
    if (exact.length) return exact.map(entry => entry.root);
    const containing = entries.filter(entry => isInside(entry.root, file)
      && ![...this.closed].some(closed => closed.length >= pathKey(entry.root).length && isInside(closed, file)));
    return containing.length ? [containing[0].root] : [];
  }
}
