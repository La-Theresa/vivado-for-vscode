import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, ResolvedProject, validateConfig, writeConfig } from './config';
import { DEFAULT_SIMULATION_RUN_TIME } from '../sim/runtime';

export async function createProjectFolder(parent: string, name: string, part: string, top: string): Promise<string> {
  const config = validateConfig({
    version: 1, name, part, top, projectDirectory: '.', simulationRunTime: DEFAULT_SIMULATION_RUN_TIME,
    sources: [`${name}.srcs/sources_1/**/*.{v,sv,vh,svh}`],
    constraints: [`${name}.srcs/constrs_1/**/*.xdc`],
    simulation: [`${name}.srcs/sim_1/**/*.{v,sv,vh,svh}`],
  });
  const root = path.resolve(parent, name);
  // Exclusive creation never replaces an existing Vivado project or user files.
  try { await fs.mkdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Project folder already exists: ${root}. Choose a different name or open ${CONFIG_FILE}.`);
    throw error;
  }
  await writeConfig(root, config);
  return root;
}

export async function createProjectSourceFolders(project: ResolvedProject): Promise<void> {
  // Vivado 2018.3 refuses create_project if <name>.srcs already exists.
  await fs.access(project.xpr);
  for (const fileset of ['sources_1', 'constrs_1', 'sim_1']) {
    await fs.mkdir(path.join(project.projectDir, `${project.config.name}.srcs`, fileset, 'new'), { recursive: true });
  }
}
