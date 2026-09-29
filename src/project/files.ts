import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { FileGroup, ProjectConfig, ResolvedProject, isHdl, portablePath, readConfig, resolveProject, writeConfig } from './config';
import { isInside } from './projects';
import { pathKey } from '../toolchain/messageParser';

export function newFileDirectory(project: ResolvedProject, group: FileGroup): string {
  if (project.config.projectDirectory === '.') {
    const fileset = { sources: 'sources_1', constraints: 'constrs_1', simulation: 'sim_1' }[group];
    return path.join(project.root, `${project.config.name}.srcs`, fileset, 'new');
  }
  const existing = project.files[group].find(file => isInside(project.root, file));
  return existing ? path.dirname(existing) : path.join(project.root, { sources: 'rtl', constraints: 'constraints', simulation: 'sim' }[group]);
}

export function fileModuleName(filename: string, group: FileGroup): string {
  const extension = path.extname(filename);
  const name = path.basename(filename, extension);
  if (!(group === 'constraints' ? /^\.xdc$/i : /^\.(v|sv)$/i).test(extension)) {
    throw new Error(group === 'constraints' ? 'Use an .xdc filename.' : 'Use a .v or .sv filename.');
  }
  const valid = group === 'constraints' ? /^[^<>:"/\\|?*\0\r\n]+$/.test(name) && !/[ .]$/.test(name) : /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
  if (!valid || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    if (group === 'constraints') throw new Error('Use a valid .xdc filename, not a reserved device name.');
    throw new Error('Use a valid module name as the filename: letters, digits, underscores or $, beginning with a letter or underscore.');
  }
  return name;
}

export function sourceTemplate(config: ProjectConfig, group: FileGroup, filename: string, version = '', date = new Date()): string {
  const name = fileModuleName(filename, group);
  const prefix = group === 'constraints' ? '#' : '//';
  const header = [
    prefix.repeat(group === 'constraints' ? 78 : 39),
    `${prefix} Company:`,
    `${prefix} Engineer:`,
    `${prefix}`,
    `${prefix} Create Date: ${date.toISOString()}`,
    `${prefix} Design Name: ${config.top}`,
    `${prefix} Module Name: ${group === 'constraints' ? '' : name}`,
    `${prefix} Project Name: ${config.name}`,
    `${prefix} Target Devices: ${config.part}`,
    `${prefix} Tool Versions: ${version ? `Vivado ${version}` : ''}`,
    `${prefix} Description:`,
    `${prefix}`,
    `${prefix} Dependencies:`,
    `${prefix}`,
    `${prefix} Revision:`,
    `${prefix} Revision 0.01 - File Created`,
    `${prefix} Additional Comments:`,
    `${prefix}`,
    prefix.repeat(group === 'constraints' ? 78 : 39),
    '',
  ].join('\n');
  if (group === 'constraints') return header;
  const body = group === 'simulation'
    ? `module ${name};\n\n    reg clk = 1'b0;\n    always #5 clk = ~clk;\n\n    initial begin\n        // Add test stimulus here.\n        #1000;\n        $finish;\n    end`
    : `module ${name} (\n\n);`;
  return '`timescale 1ns / 1ps\n\n' + header + `\n${body}\n\nendmodule\n`;
}

export async function createProjectFile(root: string, group: FileGroup, filename: string, version?: string): Promise<string> {
  const file = path.resolve(filename);
  if (!isInside(root, file) || file === path.resolve(root)
    || /(^|[\\/])(?:\.[^\\/]+|node_modules|[^\\/]+\.(?:runs|cache|sim|hw|gen|ip_user_files))([\\/]|$)/i.test(path.relative(root, file))) {
    throw new Error('Create source files inside the project, outside generated or hidden directories.');
  }
  const name = fileModuleName(file, group);
  const project = await resolveProject(root);
  if (isInside(path.join(project.projectDir, `${project.config.name}.srcs`), file)) {
    await fs.access(project.xpr).catch(() => { throw new Error('Synchronize the Vivado project before creating files in its native .srcs directory.'); });
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, sourceTemplate(project.config, group, file, version), { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`File already exists: ${file}. Choose a different filename or add the existing file.`);
    throw error;
  }
  const config = await readConfig(root);
  const relative = portablePath(path.relative(root, file));
  const pattern = fg.escapePath(relative);
  if (!config[group].includes(pattern)) config[group].push(pattern);
  config.exclude = config.exclude.filter(value => value !== relative && value !== pattern);
  if (group === 'sources' && !project.files.sources.some(isHdl)) config.top = name;
  if (group === 'simulation' && !config.simulationTop) config.simulationTop = name;
  if (!(await resolveProject(root, config)).files[group].some(source => pathKey(source) === pathKey(file))) {
    throw new Error(`File created at ${file}, but an exclusion pattern prevents adding it to the project. Update exclude in vivado-project.json.`);
  }
  await writeConfig(root, config);
  return file;
}
