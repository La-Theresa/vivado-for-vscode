import fs from 'node:fs/promises';
import path from 'node:path';
import { WaveData, WaveSignal } from '../views/previewModel';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const modules = new Map<string, Promise<WebAssembly.Module>>();
interface ParserExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  vcd_abi_version(): number;
  vcd_alloc(length: number): number;
  vcd_parse(pointer: number, length: number): number;
  vcd_free(pointer: number, length: number): void;
}
interface ParsedData {
  unit: string;
  timescale: number;
  endTime: number;
  signals: { name: string; width: number; type: string; timeline: number }[];
  timelines: WaveSignal['changes'][];
}

async function loadModule(wasmFile: string): Promise<WebAssembly.Module> {
  const filename = path.resolve(wasmFile);
  let module = modules.get(filename);
  if (!module) {
    module = fs.readFile(filename).then(bytes => WebAssembly.compile(bytes)).catch(error => {
      modules.delete(filename);
      throw error;
    });
    modules.set(filename, module);
  }
  return module;
}

export async function readWaveform(filename: string, wasmFile: string): Promise<WaveData> {
  if ((await fs.stat(filename)).size > MAX_FILE_BYTES) throw new Error('VCD exceeds the 8 MiB preview limit. Use the WDB viewer or a shorter simulation.');
  const content = await fs.readFile(filename, 'utf8');
  return parseWaveform(content, filename, wasmFile);
}

export async function parseWaveform(content: string, source: string, wasmFile: string): Promise<WaveData> {
  const input = Buffer.from(content, 'utf8');
  if (input.length > MAX_FILE_BYTES) throw new Error('VCD exceeds the 8 MiB preview limit.');
  if (!input.length) throw new Error('VCD input is empty.');
  // Reuse compiled code, not linear memory. Each parse releases its entire heap,
  // including after a WASM trap, instead of retaining the largest waveform.
  const parser = new WebAssembly.Instance(await loadModule(wasmFile)).exports as ParserExports;
  if (parser.vcd_abi_version?.() !== 1) throw new Error('Unsupported VCD parser ABI. Rebuild the extension.');
  let pointer = 0, output = 0, outputLength = 0, trapped = false;
  try {
    pointer = parser.vcd_alloc(input.length);
    if (!pointer) throw new Error('Cannot allocate the VCD input buffer.');
    new Uint8Array(parser.memory.buffer, pointer, input.length).set(input);
    output = parser.vcd_parse(pointer, input.length);
    outputLength = new DataView(parser.memory.buffer).getUint32(output, true);
    if (outputLength > 64 * 1024 * 1024) throw new Error('VCD parser output exceeds the preview limit.');
    const response = JSON.parse(Buffer.from(parser.memory.buffer, output + 4, outputLength).toString('utf8')) as { data?: ParsedData; error?: string };
    if (response.error) throw new Error(response.error);
    if (!response.data) throw new Error('VCD parser returned no waveform.');
    const data = response.data;
    return {
      kind: 'waveform', title: path.basename(source), source,
      unit: data.unit, timescale: data.timescale, endTime: data.endTime,
      signals: data.signals.map(signal => ({
        name: signal.name, width: signal.width, type: signal.type, changes: data.timelines[signal.timeline],
      })),
    };
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      trapped = true;
      throw new Error('VCD parsing exceeded WASM resource limits or failed. Use the WDB viewer.');
    }
    throw error;
  } finally {
    // An aborted allocator must not be called again; discard that instance.
    if (!trapped) {
      if (pointer) parser.vcd_free(pointer, input.length);
      if (output) parser.vcd_free(output, outputLength + 4);
    }
  }
}
