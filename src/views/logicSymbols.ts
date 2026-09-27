import { CircuitNode } from './previewModel';

export type LogicKind = 'and' | 'or' | 'xor' | 'buffer' | 'flipflop' | 'latch' | 'mux' | 'ground' | 'power' | 'portIn' | 'portOut' | 'portInout' | 'block';
export interface LogicSymbol { kind: LogicKind; inverted?: boolean; invertedInputs?: string[] }

export function logicSymbol(node: CircuitNode): LogicSymbol {
  if (node.port) return { kind: node.type === 'IN PORT' ? 'portIn' : node.type === 'OUT PORT' ? 'portOut' : 'portInout' };
  const type = node.type.toUpperCase();
  if (type === 'GND') return { kind: 'ground' };
  if (type === 'VCC') return { kind: 'power' };
  if (/^FD(?:RE|SE|CE|PE|RSE|CPE|R|S|C|P)?(?:_1)?$/.test(type)) return { kind: 'flipflop' };
  if (/^LD(?:CE|PE|C|P)(?:_1)?$/.test(type)) return { kind: 'latch' };
  if (/^MUXF[5-9]$/.test(type)) return { kind: 'mux' };
  if (['IBUF', 'OBUF', 'BUF', 'BUFG', 'BUFH', 'BUFIO'].includes(type)) return { kind: 'buffer' };
  if (type === 'INV') return { kind: 'buffer', inverted: true };
  const direct = type.match(/^(AND|NAND|OR|NOR|XOR|XNOR)[2-8]?$/);
  if (direct) return { kind: direct[1].includes('X') ? 'xor' : direct[1].includes('AND') ? 'and' : 'or', inverted: ['NAND', 'NOR', 'XNOR'].includes(direct[1]) };
  const lut = type.match(/^LUT([1-6])$/);
  const init = node.properties?.INIT?.replace(/_/g, '').match(/^(\d+)'([hb])([0-9a-f]+)$/i);
  if (!lut || !init) return { kind: 'block' };
  const inputs = Number(lut[1]), rows = 2 ** inputs;
  if (Number(init[1]) !== rows || (init[2].toLowerCase() === 'b' && /[^01]/.test(init[3]))) return { kind: 'block' };
  const value = BigInt(`${init[2].toLowerCase() === 'b' ? '0b' : '0x'}${init[3]}`);
  if (value >= 1n << BigInt(rows)) return { kind: 'block' };
  const table = Array.from({ length: rows }, (_, row) => Number((value >> BigInt(row)) & 1n));
  const same = (fn: (row: number) => number) => table.every((bit, row) => bit === fn(row));
  if (inputs === 1) {
    if (same(row => row)) return { kind: 'buffer' };
    if (same(row => 1 - row)) return { kind: 'buffer', inverted: true };
    return { kind: 'block' };
  }
  const and = (row: number) => Number(row === rows - 1), or = (row: number) => Number(row !== 0);
  const xor = (row: number) => row.toString(2).replace(/0/g, '').length % 2;
  for (const [kind, fn] of [['and', and], ['or', or], ['xor', xor]] as const) {
    if (same(fn)) return { kind };
    if (same(row => 1 - fn(row))) return { kind, inverted: true };
  }
  // A single minterm/maxterm is still one distinctive gate with input bubbles.
  const ones = table.reduce((sum, bit) => sum + bit, 0);
  if (ones === 1 || ones === rows - 1) {
    const kind = ones === 1 ? 'and' : 'or', row = table.indexOf(ones === 1 ? 1 : 0);
    const invertedInputs = Array.from({ length: inputs }, (_, index) => index)
      .filter(index => kind === 'and' ? !(row & (1 << index)) : !!(row & (1 << index))).map(index => `I${index}`);
    return { kind, invertedInputs };
  }
  return { kind: 'block' };
}
