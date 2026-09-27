import fs from 'node:fs/promises';
import path from 'node:path';

export interface ResourceRow { name: string; used: string; available: string; percent: string }
export interface ReportData { resources: ResourceRow[]; metrics: Record<string, string>; drc: string; directory: string }

export function parseUtilization(text: string): ResourceRow[] {
  const resources: ResourceRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.split('|').map(s => s.trim());
    if (columns.length >= 6 && /^(Slice LUTs|Slice Registers|CLB LUTs|CLB Registers|Block RAM Tile|DSPs|DSP48E\d*|Bonded IOB|BUFGCTRL)/.test(columns[1])) {
      const numeric = columns.slice(2, -1);
      resources.push({ name: columns[1].replace(/\*$/, '').trim(), used: numeric[0], available: numeric[numeric.length - 2], percent: numeric[numeric.length - 1] });
    }
  }
  return resources;
}

export async function readReports(root: string): Promise<ReportData> {
  const directory = path.join(root, '.vivado', 'reports');
  const [utilization, metricsText, drc] = await Promise.all(['utilization.rpt', 'metrics.tsv', 'drc.rpt'].map(file => fs.readFile(path.join(directory, file), 'utf8').catch(() => '')));
  return { directory, resources: parseUtilization(utilization),
    metrics: Object.fromEntries(metricsText.split(/\r?\n/).filter(line => line.includes('\t')).map(line => line.split('\t', 2))), drc };
}
