import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { CancelledError, killProcessTree, spawnTool } from './process';
import { tclString } from '../project/sync';

interface Pending {
  id: string;
  buffer: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export class TclSession {
  private child?: ChildProcess;
  private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private executable: string, private cwd: string, private encoding = 'utf8', private log?: (text: string) => void) {}

  execute(script: string, signal?: AbortSignal, timeoutMs = 30000): Promise<string> {
    const result = this.queue.then(() => this.executeNow(script, signal, timeoutMs));
    this.queue = result.catch(() => {});
    return result;
  }

  private start(): void {
    if (this.child) return;
    const child = spawnTool(this.executable, ['-mode', 'tcl', '-nolog', '-nojournal', '-notrace'], this.cwd);
    this.child = child;
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = iconv.getDecoder(this.encoding);
      stream.on('data', (data: Buffer) => this.receive(decoder.write(data)));
      stream.on('end', () => this.receive(decoder.end() || ''));
    }
    child.on('error', error => { if (this.child === child) this.fail(error); });
    child.stdin!.on('error', error => { if (this.child === child) this.fail(error); });
    child.on('close', code => {
      if (this.child === child) {
        this.child = undefined;
        this.fail(new Error(`Vivado Tcl session closed (exit ${code}).`));
      }
    });
  }

  private receive(text: string): void {
    this.log?.(text);
    const pending = this.pending;
    if (!pending) return;
    pending.buffer += text;
    if (pending.buffer.length > 8 * 1024 * 1024) {
      this.fail(new Error('Tcl response exceeds 8 MB.'));
      void this.stop();
      return;
    }
    const begin = `@@BEGIN:${pending.id}@@`;
    const end = pending.buffer.match(new RegExp(`@@END:${pending.id}:(\\d+):([0-9a-f]*)@@`));
    const start = pending.buffer.indexOf(begin);
    if (start < 0 || !end || end.index === undefined || end.index < start) return;
    this.pending = undefined;
    const result = Buffer.from(end[2], 'hex').toString('utf8');
    if (Number(end[1]) !== 0) pending.reject(new Error(result));
    else pending.resolve(result);
  }

  private executeNow(script: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Tcl session has been disposed.'));
    if (signal?.aborted) return Promise.reject(new CancelledError());
    this.start();
    return new Promise((resolve, reject) => {
      const id = randomUUID().replace(/-/g, '');
      const abort = () => { this.fail(new CancelledError()); void this.stop(); };
      const timer = setTimeout(() => { this.fail(new Error('Vivado Tcl command timed out.')); void this.stop(); }, timeoutMs);
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending = {
        id, buffer: '',
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.child!.stdin!.write(
        `puts "@@BEGIN:${id}@@"\n` +
        `set __vsc_code [catch ${tclString(script)} __vsc_result]\n` +
        `binary scan [encoding convertto utf-8 $__vsc_result] H* __vsc_hex\n` +
        `puts "@@END:${id}:$__vsc_code:$__vsc_hex@@"\n`,
      );
    });
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) await killProcessTree(child);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.fail(new CancelledError());
    await this.stop();
  }
}
