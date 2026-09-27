import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { CircuitNode } from '../views/previewModel';
import { logicSymbol } from '../views/logicSymbols';
import { svg } from './svg';

const truncate = (text: string, width: number) => text.length * 7 <= width ? text : `${text.slice(0, Math.max(1, Math.floor(width / 7) - 3))}...`;

export function circuitSymbol(node: CircuitNode, box: ElkNode): SVGGElement {
  const spec = logicSymbol(node), w = box.width!, h = box.height!;
  const group = svg('g', { transform: `translate(${box.x || 0},${box.y || 0})`, class: `circuit-node${node.port ? ' port-node' : ''}`,
    'data-symbol': spec.kind, tabindex: 0, role: 'button', 'aria-label': `${node.name}, ${node.type}` });
  group.append(svg('title', {}, `${node.name}\n${node.type}${node.properties?.INIT ? `\nINIT ${node.properties.INIT}` : ''}${node.port ? '\nI/O Planning' : ''}`));
  group.append(svg('rect', { x: 0, y: 0, width: w, height: h, class: 'symbol-hitbox' }));
  const path = (d: string, filled = true) => group.append(svg('path', { d, class: filled ? 'symbol-body' : 'symbol-line' }));
  const line = (x1: number, y1: number, x2: number, y2: number) => path(`M${x1},${y1}L${x2},${y2}`, false);
  const bubble = (x: number, y: number) => group.append(svg('circle', { cx: x, cy: y, r: 5, class: 'symbol-body inversion' }));
  if (node.port) {
    const mid = h / 2;
    path(spec.kind === 'portIn' ? `M8,8H${w - 28}L${w - 10},${mid}L${w - 28},${h - 8}H8Z`
      : spec.kind === 'portOut' ? `M10,${mid}L28,8H${w - 8}V${h - 8}H28Z`
      : `M8,${mid}L24,8H${w - 24}L${w - 8},${mid}L${w - 24},${h - 8}H24Z`);
    line(spec.kind === 'portOut' ? -3 : w - 10, mid, spec.kind === 'portOut' ? 10 : w + 3, mid);
    group.append(svg('text', { x: w / 2, y: mid + 4, 'text-anchor': 'middle', class: 'cell-name' }, truncate(node.name, w - 60)));
    return group;
  }
  const left = 42, right = w - 42, top = 32, bottom = h - 24, mid = (top + bottom) / 2, gw = right - left;
  group.append(svg('text', { x: w / 2, y: 16, 'text-anchor': 'middle', class: 'cell-name' }, truncate(node.name, w - 8)));
  const simple = ['and', 'or', 'xor', 'buffer'].includes(spec.kind);
  if (spec.kind === 'and') path(`M${left},${top}H${left + gw * 0.4}A${gw * 0.6},${(bottom - top) / 2} 0 0 1 ${left + gw * 0.4},${bottom}H${left}Z`);
  else if (spec.kind === 'or' || spec.kind === 'xor') {
    path(`M${left},${top}C${left + gw * 0.6},${top} ${right - gw * 0.15},${top + 5} ${right},${mid}C${right - gw * 0.15},${bottom - 5} ${left + gw * 0.6},${bottom} ${left},${bottom}Q${left + 36},${mid} ${left},${top}Z`);
    if (spec.kind === 'xor') path(`M${left - 7},${top}Q${left + 29},${mid} ${left - 7},${bottom}`, false);
  } else if (spec.kind === 'buffer') path(`M${left},${top}L${right},${mid}L${left},${bottom}Z`);
  else if (spec.kind === 'mux') path(`M${left},${top}L${right},${top + 13}V${bottom - 13}L${left},${bottom}Z`);
  else if (spec.kind === 'ground') {
    const x = w / 2;
    path(`M${right},${mid}H${x}V${mid + 9}M${x - 18},${mid + 9}H${x + 18}M${x - 12},${mid + 15}H${x + 12}M${x - 6},${mid + 21}H${x + 6}`, false);
  } else if (spec.kind === 'power') {
    const x = w / 2;
    path(`M${right},${mid}H${x}V${mid - 10}M${x - 12},${mid - 10}L${x},${mid - 23}L${x + 12},${mid - 10}Z`, false);
  } else group.append(svg('rect', { x: left, y: top, width: gw, height: bottom - top, class: 'symbol-body' }));
  if (simple && spec.inverted) bubble(right + 5, mid);
  for (const port of box.ports || []) {
    const pin = node.pins.find(pin => pin.id === port.id)!;
    const x = (port.x || 0) + 3, y = (port.y || 0) + 3, input = pin.direction === 'IN';
    if (spec.kind === 'mux' && pin.name === 'S') {
      line(x, h, x, bottom - 6);
      group.append(svg('text', { x: x + 7, y: bottom + 9, class: 'pin-name' }, 'S'));
      continue;
    }
    const clock = spec.kind === 'flipflop' && (pin.name === 'C' || pin.name === 'CLK');
    const inverted = input && (spec.invertedInputs?.includes(pin.name) || node.properties?.[`IS_${pin.name}_INVERTED`] === '1' || (clock && /_1$/.test(node.type)));
    let boundary = input ? left : right;
    if (input && (spec.kind === 'or' || spec.kind === 'xor')) {
      const t = (y - top) / (bottom - top);
      boundary += 72 * t * (1 - t);
    }
    const endY = !input && simple ? mid : y;
    const extra = !input && simple && spec.inverted ? 10 : inverted ? -10 : 0;
    path(`M${x + (input ? -3 : 3)},${y}H${input ? 18 : w - 18}V${endY}H${boundary + extra}`, false);
    if (inverted) bubble(boundary - 5, y);
    if (clock) path(`M${left},${y - 6}L${left + 9},${y}L${left},${y + 6}`, false);
    if (!simple && !['ground', 'power'].includes(spec.kind)) {
      group.append(svg('text', { x: input ? left + (clock ? 14 : 8) : right - 8, y: y + 4, 'text-anchor': input ? 'start' : 'end', class: 'pin-name' }, truncate(clock ? '' : pin.name, gw / 2 - 12)));
    }
    group.append(svg('circle', { cx: x, cy: y, r: 2.5, class: 'pin' }));
  }
  group.append(svg('text', { x: w / 2, y: spec.kind === 'mux' ? mid + 4 : h - 7, 'text-anchor': 'middle', class: 'cell-type' }, node.type));
  return group;
}
