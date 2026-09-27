import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ProjectConfig, portablePath, validateConfig } from './config';
import { DEFAULT_SIMULATION_RUN_TIME } from '../sim/runtime';

interface Option { Name: string; Val: string }
interface XprFile { Path: string; FileInfo?: { Attr?: Option[] } }
interface FileSet { Name: string; Type: string; File?: XprFile[]; Config?: { Option?: Option[]; Define?: { Name: string; Val?: string }[] } }

export function splitTclList(input: string): string[] {
  const result: string[] = [];
  let token = '', depth = 0, quoted = false, active = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '\\' && index + 1 < input.length) { token += input[++index]; active = true; }
    else if (char === '{' && !quoted) { if (depth++) token += char; active = true; }
    else if (char === '}' && !quoted) { if (--depth < 0) throw new Error('Invalid Tcl list in XPR.'); if (depth) token += char; }
    else if (char === '"' && depth === 0) { quoted = !quoted; active = true; }
    else if (/\s/.test(char) && depth === 0 && !quoted) { if (active) result.push(token); token = ''; active = false; }
    else { token += char; active = true; }
  }
  if (depth || quoted) throw new Error('Unbalanced Tcl list in XPR.');
  if (active) result.push(token);
  return result;
}

export function importXpr(xml: string, xprPath: string, workspaceRoot: string): { config: ProjectConfig; warnings: string[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XPR files with XML entities are not supported.');
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid XPR XML.');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
    isArray: name => ['Option', 'FileSet', 'File', 'Attr', 'Define'].includes(name),
  });
  const project = parser.parse(xml).Project;
  if (!project) throw new Error('Not a Vivado XPR project.');
  const options: Option[] = project.Configuration?.Option || [];
  const fileSets: FileSet[] = project.FileSets?.FileSet || [];
  const design = fileSets.find(set => set.Name === 'sources_1') || fileSets.find(set => set.Type === 'DesignSrcs');
  const sim = fileSets.find(set => set.Name === 'sim_1') || fileSets.find(set => set.Type === 'SimulationSrcs');
  const constraints = fileSets.find(set => set.Name === 'constrs_1') || fileSets.find(set => set.Type === 'Constrs');
  const projectDir = path.dirname(xprPath);
  const baseName = path.basename(xprPath, path.extname(xprPath));
  const warnings = ['Import preserves file references, device, tops, includes and defines; run strategies and per-file properties are not imported.'];
  const resolve = (value: string): string => {
    const expanded = value.replace(/\$(PPRDIR|PSRCDIR|PIPUSERFILESDIR)\b/g, (_, variable: string) => ({
      PPRDIR: portablePath(projectDir),
      PSRCDIR: portablePath(path.join(projectDir, `${baseName}.srcs`)),
      PIPUSERFILESDIR: portablePath(path.join(projectDir, `${baseName}.ip_user_files`)),
    }[variable]!));
    if (/\$[A-Z_]+/.test(expanded)) throw new Error(`Unresolved XPR path variable: ${value}`);
    return portablePath(path.relative(workspaceRoot, path.resolve(projectDir, expanded)));
  };
  const files = (set?: FileSet) => (set?.File || []).map(file => resolve(file.Path));
  const get = (set: FileSet | undefined, name: string) => set?.Config?.Option?.find(o => o.Name === name)?.Val;
  const array = (set: FileSet | undefined, name: string) => (set?.Config?.Option || []).filter(o => o.Name === name).flatMap(o => splitTclList(o.Val));
  const includes = (set?: FileSet) => [...(set?.Config?.Option || []).filter(o => o.Name === 'VerilogDir').map(o => o.Val), ...array(set, 'IncludeDirs')];
  const definitions = (set?: FileSet) => [...(set?.Config?.Define || []).map(d => d.Val === undefined ? d.Name : `${d.Name}=${d.Val}`), ...array(set, 'VerilogDefines')];
  const defines = new Map<string, string>();
  for (const define of [...definitions(design), ...definitions(sim)]) {
    const name = define.split('=', 1)[0];
    if (defines.has(name) && defines.get(name) !== define) warnings.push(`Different design/simulation values for ${name}; the design value is retained. Review project defines.`);
    else defines.set(name, define);
  }
  const config = validateConfig({
    version: 1,
    name: baseName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]/, '_'),
    part: options.find(o => o.Name === 'Part')?.Val,
    top: get(design, 'TopModule') || 'top',
    sources: files(design), constraints: files(constraints), simulation: files(sim),
    includeDirs: [...new Set([...includes(design), ...includes(sim)].map(resolve))],
    defines: [...defines.values()],
    simulationRunTime: DEFAULT_SIMULATION_RUN_TIME,
    ...(get(sim, 'TopModule') ? { simulationTop: get(sim, 'TopModule') } : {}),
  });
  if (config.sources.some(f => /\.(xci|bd)$/i.test(f))) warnings.push('IP/block designs are listed only. Use Vivado GUI to manage IP and generate output products.');
  if ([...config.sources, ...config.simulation].some(f => /\.vhdl?$/i.test(f))) warnings.push('Live checking and simulation currently support Verilog/SystemVerilog only.');
  return { config, warnings };
}
