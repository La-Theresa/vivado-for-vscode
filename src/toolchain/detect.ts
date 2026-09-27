import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './process';

export interface Toolchain {
  root: string;
  version: string;
  vivado: string;
  xvlog: string;
  xelab: string;
  xsim: string;
  glbl: string;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

export async function detectToolchain(configured?: string): Promise<Toolchain | undefined> {
  const suffix = process.platform === 'win32' ? '.bat' : '';
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const normalized = path.resolve(candidate);
    candidates.push(path.basename(normalized).toLowerCase() === 'bin' ? path.dirname(normalized) : normalized);
  };
  if (configured) add(configured);
  if (process.env.XILINX_VIVADO) add(process.env.XILINX_VIVADO);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && await exists(path.join(dir, `vivado${suffix}`))) add(path.dirname(dir));
  }
  const bases = process.platform === 'win32'
    ? ['C:', 'D:', 'E:'].flatMap(drive => [`${drive}/Xilinx/Vivado`, `${drive}/AMD/Vivado`, `${drive}/vivado/Vivado`])
    : ['/tools/Xilinx/Vivado', '/opt/Xilinx/Vivado', '/opt/AMD/Vivado', '/tools/AMD/Vivado'];
  for (const base of bases) {
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
      add(path.join(base, entry.name));
    }
  }
  // A configured installation must not silently fall back to a different version.
  for (const root of [...new Set(configured ? candidates.slice(0, 1) : candidates)]) {
    const tools = Object.fromEntries(['vivado', 'xvlog', 'xelab', 'xsim'].map(tool => [tool, path.join(root, 'bin', tool + suffix)]));
    if (!(await Promise.all(Object.values(tools).map(exists))).every(Boolean)) continue;
    const result = await runProcess(tools.vivado, ['-version'], { cwd: os.tmpdir(), timeoutMs: 30000 }).catch(() => undefined);
    const version = result?.output.match(/Vivado\s+v?(\d{4}\.\d+(?:\.\d+)?)/i)?.[1];
    if (result?.code === 0 && version) return { root, version, ...tools, glbl: path.join(root, 'data/verilog/src/glbl.v') } as Toolchain;
  }
  return undefined;
}
