import fs from 'node:fs/promises';
import path from 'node:path';
import * as vcd from 'rust_vcd_wasm/rust_vcd_wasm_bg.js';
import type { VcdHeader, VcdScope } from 'rust_vcd_wasm';
import { WaveData, WaveSignal } from '../views/previewModel';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
let initialized: Promise<void> | undefined;

async function initialize(wasmFile: string): Promise<void> {
  initialized ??= fs.readFile(wasmFile).then(async bytes => {
    const imports: WebAssembly.ModuleImports = {};
    for (const [name, value] of Object.entries(vcd)) if (typeof value === 'function') imports[name] = value;
    const instance = await WebAssembly.instantiate(bytes, { './rust_vcd_wasm_bg.js': imports });
    vcd.__wbg_set_wasm(instance.instance.exports);
  }).catch(error => { initialized = undefined; throw error; });
  return initialized;
}

export async function readWaveform(filename: string, wasmFile: string): Promise<WaveData> {
  if ((await fs.stat(filename)).size > MAX_FILE_BYTES) throw new Error('VCD exceeds the 8 MiB preview limit. Use the WDB viewer or a shorter simulation.');
  const content = await fs.readFile(filename, 'utf8');
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('VCD grew beyond the preview limit. Wait for simulation to finish.');
  return parseWaveform(content, filename, wasmFile);
}

export async function parseWaveform(content: string, source: string, wasmFile: string): Promise<WaveData> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('VCD exceeds the 8 MiB preview limit.');
  await initialize(wasmFile);
  let data: vcd.VcdData;
  const headerText = content.split('$enddefinitions', 1)[0];
  if (!/\$timescale\b/.test(headerText) || !content.includes('$enddefinitions')) throw new Error('VCD is missing its timescale or signal definitions.');
  // The upstream wrapper expects the optional date/version metadata to exist.
  for (const key of ['date', 'version']) if (!new RegExp(`\\$${key}\\b`).test(headerText)) content = `$${key} Unknown $end\n${content}`;
  // This parser flushes a pending frame at the next timestamp, not at EOF.
  let lastTimestamp = '0';
  for (const match of content.matchAll(/^\s*#(\d+)\s*$/gm)) lastTimestamp = match[1];
  try { data = vcd.parse(`${content}\n#${lastTimestamp}\n`); }
  catch { throw new Error('Cannot parse this VCD. Use the WDB viewer for unsupported or incomplete waveforms.'); }
  const signals: WaveSignal[] = [], byCode = new Map<string, WaveSignal[]>();
  const header = data.get_vcd_header();
  try {
    const visit = (scope: VcdHeader | VcdScope, prefix: string[], depth: number) => {
      if (depth > 64) throw new Error('VCD hierarchy is too deep for preview.');
      for (let i = 0; i < scope.get_items_size(); i++) {
        const item = scope.get_items_data(i), child = item.get_scope(), variable = item.get_var();
        try {
          if (child) visit(child, [...prefix, child.get_identifier()], depth + 1);
          if (variable) {
            if (signals.length >= 2048) throw new Error('VCD exceeds 2048 signals. Use the WDB viewer.');
            const type = variable.get_var_type(), code = variable.get_var_code(), width = variable.get_size();
            if (width > 4096) throw new Error('VCD bus is too wide for preview.');
            const signal: WaveSignal = {
              name: [...prefix, variable.get_reference()].join('.'), width,
              type: type === vcd.VcdVarType.Real ? 'real' : type === vcd.VcdVarType.String ? 'string' : 'logic', changes: [],
            };
            const aliases = byCode.get(code) || [];
            if (aliases.length) signal.changes = aliases[0].changes;
            aliases.push(signal);
            byCode.set(code, aliases);
            signals.push(signal);
          }
        } finally { variable?.free(); child?.free(); item.free(); }
      }
    };
    visit(header, [], 0);
    let endTime = 0, changes = 0;
    const append = (code: string, time: number, value: string) => {
      const signal = byCode.get(code)?.[0];
      if (!signal) throw new Error('VCD contains an undeclared signal.');
      if (++changes > 500000) throw new Error('VCD exceeds 500000 changes. Use the WDB viewer or a shorter simulation.');
      if (signal.type === 'logic') value = value.padStart(signal.width, /^[xz]/i.test(value) ? value[0] : '0');
      const previous = signal.changes.at(-1);
      if (previous?.[0] === time) previous[1] = value;
      else if (previous?.[1] !== value) signal.changes.push([time, value]);
    };
    const values = ['0', '1', 'x', 'z'];
    for (let i = 0; i < data.get_vcd_signal_size(); i++) {
      const frame = data.get_vcd_signal_data(i);
      try {
        const time = Number(frame.get_time());
        if (!Number.isSafeInteger(time) || time < endTime) throw new Error('VCD timestamps cannot be represented accurately in this preview.');
        endTime = time;
        for (let j = 0; j < frame.get_data_array_scalar_size(); j++) {
          append(frame.get_data_array_scalar_id_code(j), time, values[frame.get_data_array_scalar_value(j)]);
        }
        for (let j = 0; j < frame.get_data_array_vector_size(); j++) {
          const size = frame.get_data_array_vector_value_size(j);
          if (size > 4096) throw new Error('VCD bus is too wide for preview.');
          let value = '';
          for (let k = 0; k < size; k++) value += values[frame.get_data_array_vector_value_data(j, k)];
          append(frame.get_data_array_vector_id_code(j), time, value);
        }
        for (let j = 0; j < frame.get_data_array_real_size(); j++) append(frame.get_data_array_real_id_code(j), time, String(frame.get_data_array_real_value(j)));
        for (let j = 0; j < frame.get_data_array_string_size(); j++) append(frame.get_data_array_string_id_code(j), time, frame.get_data_array_string_value(j));
      } finally { frame.free(); }
    }
    const finalTimestamp = Number(lastTimestamp);
    if (!Number.isSafeInteger(finalTimestamp)) throw new Error('VCD timestamps cannot be represented accurately in this preview.');
    endTime = Math.max(endTime, finalTimestamp);
    const unit = ['s', 'ms', 'us', 'ns', 'ps', 'fs'][header.get_timescale_unit()], timescale = header.get_timescale_value();
    if (!unit || timescale <= 0 || !signals.length) throw new Error('VCD has no supported signals or timescale.');
    return { kind: 'waveform', title: path.basename(source), source, unit, timescale, endTime, signals };
  } finally { header.free(); data.free(); }
}
