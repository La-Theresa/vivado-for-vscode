import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Toolchain } from '../toolchain/detect';
import { TclSession } from '../toolchain/tclSession';

export async function installedParts(tools: Toolchain, cacheDir: string, session: TclSession, signal?: AbortSignal): Promise<string[]> {
  const key = createHash('sha256').update(`${tools.root}|${tools.version}`).digest('hex').slice(0, 16);
  const cache = path.join(cacheDir, `parts-${key}.json`);
  const stored: unknown = await fs.readFile(cache, 'utf8').then(JSON.parse).catch(() => undefined);
  if (Array.isArray(stored) && stored.length > 0 && stored.every(p => typeof p === 'string' && /^[a-z0-9_-]+$/i.test(p))) return stored;
  const result = await session.execute('join [lsort [get_parts -quiet]] "\\n"', signal, 60000);
  const parts = result.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('No installed Vivado devices were found.');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cache, JSON.stringify(parts), 'utf8');
  return parts;
}
