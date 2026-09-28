import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { normalizeSimulationRunTime } from '../sim/runtime';

export const CONFIG_FILE = 'vivado-project.json';
export type FileGroup = 'sources' | 'constraints' | 'simulation';
export interface ProjectConfig {
  version: 1;
  name: string;
  part: string;
  top: string;
  sources: string[];
  constraints: string[];
  simulation: string[];
  exclude: string[];
  includeDirs: string[];
  defines: string[];
  simulationTop?: string;
  simulationRunTime?: string;
  ioConstraints?: string;
  projectDirectory?: string;
}
export interface ResolvedProject {
  root: string;
  config: ProjectConfig;
  files: Record<FileGroup, string[]>;
  includeDirs: string[];
  projectDir: string;
  xpr: string;
}

export function validateConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project configuration must be an object.');
  const data = value as Record<string, unknown>;
  const allowed = new Set(['version', 'name', 'part', 'top', 'sources', 'constraints', 'simulation', 'exclude', 'includeDirs', 'defines', 'simulationTop', 'simulationRunTime', 'ioConstraints', 'projectDirectory', '$schema']);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Unknown project property: ${key}`);
  if (data.version !== 1) throw new Error('Project version must be 1.');
  const text = (name: string, pattern: RegExp): string => {
    const value = data[name];
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid project ${name}.`);
    return value;
  };
  const strings = (key: string, required = false): string[] => {
    if (data[key] === undefined && !required) return [];
    if (!Array.isArray(data[key]) || !(data[key] as unknown[]).every(s => typeof s === 'string' && s.length > 0 && !/[\0\r\n]/.test(s))) {
      throw new Error(`${key} must be an array of non-empty strings.`);
    }
    return [...new Set(data[key] as string[])];
  };
  const config: ProjectConfig = {
    version: 1,
    name: text('name', /^[A-Za-z_][A-Za-z0-9_-]*$/),
    part: text('part', /^[A-Za-z0-9_-]+$/),
    top: text('top', /^[A-Za-z_][A-Za-z0-9_$]*$/),
    sources: strings('sources', true), constraints: strings('constraints'), simulation: strings('simulation'),
    exclude: strings('exclude'), includeDirs: strings('includeDirs'), defines: strings('defines'),
  };
  if (config.defines.some(d => !/^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/.test(d))) throw new Error('Invalid Verilog define.');
  if (data.simulationTop !== undefined) config.simulationTop = text('simulationTop', /^[A-Za-z_][A-Za-z0-9_$]*$/);
  if (data.simulationRunTime !== undefined) config.simulationRunTime = normalizeSimulationRunTime(data.simulationRunTime);
  if (data.ioConstraints !== undefined) config.ioConstraints = text('ioConstraints', /^[^\0\r\n]+\.xdc$/i);
  if (data.projectDirectory !== undefined) {
    const directory = text('projectDirectory', /^[^\0\r\n]+$/).replace(/\\/g, '/');
    const normalized = path.posix.normalize(directory);
    if (path.win32.isAbsolute(directory) || /^[A-Za-z]:/.test(directory) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error('projectDirectory must be a relative directory inside the project folder.');
    }
    config.projectDirectory = normalized;
  }
  return config;
}

export async function readConfig(root: string): Promise<ProjectConfig> {
  return validateConfig(JSON.parse(await fs.readFile(path.join(root, CONFIG_FILE), 'utf8')));
}

export async function writeConfig(root: string, config: ProjectConfig): Promise<void> {
  await fs.writeFile(path.join(root, CONFIG_FILE), JSON.stringify(validateConfig(config), null, 2) + '\n', 'utf8');
}

export async function resolveProject(root: string, config?: ProjectConfig): Promise<ResolvedProject> {
  config ??= await readConfig(root);
  const files = {} as Record<FileGroup, string[]>;
  const ignore = [...PROJECT_IGNORES, ...config.exclude];
  for (const group of ['sources', 'constraints', 'simulation'] as FileGroup[]) {
    const ordered: string[] = [];
    for (const pattern of config[group]) ordered.push(...(await fg(pattern, { cwd: root, absolute: true, onlyFiles: true, unique: true, ignore, dot: false })).sort());
    files[group] = [...new Set(ordered)];
  }
  if (config.ioConstraints) {
    const planned = path.resolve(root, config.ioConstraints);
    await fs.access(planned).catch(() => { throw new Error(`I/O constraints file is missing: ${planned}. Restore it or remove ioConstraints from vivado-project.json.`); });
    files.constraints = [...files.constraints.filter(file => path.normalize(file).toLowerCase() !== path.normalize(planned).toLowerCase()), planned];
  }
  const projectDir = path.resolve(root, config.projectDirectory ?? '.vivado/project');
  return {
    root, config, files, projectDir, xpr: path.join(projectDir, `${config.name}.xpr`),
    includeDirs: config.includeDirs.map(dir => path.resolve(root, dir)),
  };
}

export const PROJECT_IGNORES = ['**/.vivado/**', '**/node_modules/**', '**/.git/**',
  '**/*.runs/**', '**/*.cache/**', '**/*.sim/**', '**/*.hw/**', '**/*.gen/**', '**/*.ip_user_files/**'];

export const isHdl = (file: string) => /\.(v|sv)$/i.test(file);
export const isHeader = (file: string) => /\.(vh|svh)$/i.test(file);
export const portablePath = (file: string) => file.replace(/\\/g, '/');

export function discoverModules(text: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"/g, ' ');
  return [...stripped.matchAll(/\bmodule\s+(?:(?:automatic|static)\s+)?([A-Za-z_][A-Za-z0-9_$]*)/g)].map(m => m[1]);
}
