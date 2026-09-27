import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import fg from 'fast-glob';
import { pathKey } from '../toolchain/messageParser';

export interface DocumentSnapshot { file: string; text: string }
export interface ShadowSnapshot {
  directory: string;
  file: (original: string) => string;
  original: (shadow: string) => string;
  includes: (original: string) => string[];
  dispose: () => Promise<void>;
}

export async function createShadow(
  root: string, files: string[], includeDirs: string[], documents: DocumentSnapshot[] = [],
): Promise<ShadowSnapshot> {
  const hash = createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16);
  const workspaceTemp = path.join(os.tmpdir(), 'vivado-vscode', hash);
  await fs.mkdir(workspaceTemp, { recursive: true });
  const directory = await fs.mkdtemp(path.join(workspaceTemp, 'check-'));
  const forward = new Map<string, string>(), reverse = new Map<string, string>();
  const directoryMap = new Map<string, string>();
  const headers = await fg('**/*.{vh,svh}', { cwd: root, absolute: true, ignore: ['**/.vivado/**', '**/node_modules/**', '**/.git/**'] });
  for (const dir of includeDirs) {
    headers.push(...await fg('**/*.{vh,svh}', { cwd: dir, absolute: true, suppressErrors: true }));
  }
  const texts = new Map(documents.map(d => [pathKey(d.file), d.text]));
  const all = [...new Set([...files, ...headers, ...documents.map(d => d.file)].map(f => path.resolve(f)))];
  const shadowPath = (file: string) => {
    const parsed = path.parse(file);
    const drive = parsed.root.replace(/[^A-Za-z0-9]/g, '_') || 'root';
    return path.join(directory, 'files', drive, file.slice(parsed.root.length));
  };
  try {
    for (const file of all) {
      const target = shadowPath(file);
      forward.set(pathKey(file), target);
      reverse.set(pathKey(target), file);
      directoryMap.set(pathKey(path.dirname(file)), path.dirname(target));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const text = texts.get(pathKey(file));
      if (text !== undefined) await fs.writeFile(target, text, 'utf8');
      else await fs.copyFile(file, target);
    }
    const includes = (original: string) => [...new Set([
      path.dirname(forward.get(pathKey(original)) || shadowPath(original)),
      ...includeDirs.map(dir => directoryMap.get(pathKey(dir)) || shadowPath(dir)),
      path.dirname(original), ...includeDirs,
    ])];
    return {
      directory, file: original => forward.get(pathKey(original)) || original,
      original: shadow => reverse.get(pathKey(shadow)) || shadow,
      includes,
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
