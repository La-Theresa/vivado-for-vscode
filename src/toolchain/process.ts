import { spawn, ChildProcess } from 'node:child_process';
import iconv from 'iconv-lite';

export class CancelledError extends Error {
  constructor() { super('Operation cancelled.'); this.name = 'CancelledError'; }
}

export interface ProcessOptions {
  cwd: string;
  signal?: AbortSignal;
  encoding?: string;
  onOutput?: (text: string) => void;
  timeoutMs?: number;
}

export interface ProcessResult { code: number; output: string }

export function spawnTool(executable: string, args: string[], cwd: string): ChildProcess {
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(executable)) {
    // cmd expands percent variables even inside quotes; reject ambiguous input.
    const quote = (value: string) => {
      if (/["%\r\n\0]/.test(value)) {
        throw new Error('Windows batch arguments cannot contain quotes, percent signs or line breaks.');
      }
      return `"${value}"`;
    };
    const command = `"${[executable, ...args].map(quote).join(' ')}"`;
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', command], {
      cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe',
    });
  }
  return spawn(executable, args, { cwd, windowsHide: true, stdio: 'pipe' });
}

export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { child.kill(); resolve(); });
      killer.on('close', () => resolve());
    });
  } else {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

export function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const child = spawnTool(executable, args, options.cwd);
    let output = '';
    let timedOut = false;
    const decoders = [iconv.getDecoder(options.encoding || 'utf8'), iconv.getDecoder(options.encoding || 'utf8')];
    const emit = (text: string) => {
      output += text;
      // Keep memory bounded for long syntheses, while streaming the complete log.
      if (output.length > 8 * 1024 * 1024) output = output.slice(-4 * 1024 * 1024);
      options.onOutput?.(text);
    };
    child.stdout!.on('data', (data: Buffer) => emit(decoders[0].write(data)));
    child.stderr!.on('data', (data: Buffer) => emit(decoders[1].write(data)));
    const abort = () => { void killProcessTree(child); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => {
      cleanup();
      for (const decoder of decoders) emit(decoder.end() || '');
      if (options.signal?.aborted) reject(new CancelledError());
      else if (timedOut) reject(new Error(`Tool timed out: ${executable}`));
      else resolve({ code: code ?? -1, output });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end();
  });
}

export function requireSuccess(result: ProcessResult, label: string): ProcessResult {
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}).\n${result.output.slice(-3000)}`);
  return result;
}
