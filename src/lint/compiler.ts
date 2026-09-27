import fs from 'node:fs/promises';
import path from 'node:path';
import { Toolchain } from '../toolchain/detect';
import { runProcess, ProcessOptions, ProcessResult } from '../toolchain/process';
import { isHdl, portablePath } from '../project/config';

export const SIM_LIBRARIES = ['unisims_ver', 'unimacro_ver', 'secureip', 'xpm'];

export interface CompileFile { path: string; includeDirs: string[] }
export interface CompileOptions extends ProcessOptions { defines?: string[] }

export async function compileFile(tools: Toolchain, file: CompileFile, options: CompileOptions): Promise<ProcessResult> {
  await fs.mkdir(options.cwd, { recursive: true });
  const args = ['--nolog', '--work', 'xil_defaultlib'];
  if (/\.sv$/i.test(file.path)) args.push('--sv');
  for (const dir of [...new Set(file.includeDirs)]) args.push('-i', portablePath(dir));
  for (const define of options.defines || []) args.push('-d', define);
  args.push(portablePath(file.path));
  return runProcess(tools.xvlog, args, options);
}

export async function compileProject(tools: Toolchain, files: CompileFile[], options: CompileOptions): Promise<ProcessResult> {
  let output = '';
  // One library is intentionally compiled serially; parallel writers corrupt xsim.dir.
  for (const file of files.filter(f => isHdl(f.path))) {
    const result = await compileFile(tools, file, options);
    output += result.output;
    if (result.code !== 0) return { code: result.code, output };
  }
  return { code: 0, output };
}

export function elaborate(
  tools: Toolchain, top: string, options: ProcessOptions & { timescale?: string; snapshot?: string; glbl?: boolean },
): Promise<ProcessResult> {
  const timescale = options.timescale || '1ns/1ps';
  if (!/^\d+(?:s|ms|us|ns|ps|fs)\/\d+(?:s|ms|us|ns|ps|fs)$/.test(timescale)) throw new Error('Invalid simulation timescale.');
  return runProcess(tools.xelab, [
    '--nolog', '--mt', 'off', '--timescale', timescale, '--debug', 'typical',
    ...SIM_LIBRARIES.flatMap(lib => ['-L', lib]),
    `xil_defaultlib.${top}`, ...(options.glbl ? ['xil_defaultlib.glbl'] : []),
    '-s', options.snapshot || 'vscode_check',
  ], options);
}

export async function parallelMap<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export const workDir = (root: string, name: string) => path.join(root, name);
