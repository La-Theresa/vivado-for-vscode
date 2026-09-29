import { createElement, ZoomIn, ZoomOut, Maximize, ExternalLink, Search, X, TableProperties } from 'lucide';
import type { IconNode } from 'lucide';
import { PreviewData, WaveData, WaveSignal, CircuitData } from '../views/previewModel';
import { layoutCircuit } from '../views/circuitLayout';
import { circuitSymbol } from './symbols';
import { svg } from './svg';
import { ioPreview } from './ioPlanning';
import './preview.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
let release = () => {};
let generation = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(icon: IconNode, title: string, action: () => void): HTMLButtonElement {
  const node = element('button', 'icon-button');
  node.title = title;
  node.setAttribute('aria-label', title);
  node.append(createElement(icon, { width: 17, height: 17, 'aria-hidden': 'true' }));
  node.addEventListener('click', action);
  return node;
}
function shell(data: PreviewData) {
  const toolbar = element('header', 'toolbar');
  const name = element('strong', 'title', `${data.kind === 'waveform' ? 'Waveform' : data.kind === 'ioPlanning' ? 'I/O Planning' : 'Schematic'}: ${data.title}`);
  name.title = data.source;
  toolbar.append(name);
  const controls = element('div', 'controls');
  toolbar.append(controls);
  const options = element('div', 'options');
  const searchBox = element('label', 'search');
  searchBox.append(createElement(Search, { width: 15, height: 15 }));
  const search = element('input');
  search.type = 'search';
  search.placeholder = data.kind === 'waveform' ? 'Filter signals' : data.kind === 'ioPlanning' ? 'Filter ports' : 'Find cell or port';
  search.setAttribute('aria-label', search.placeholder);
  searchBox.append(search);
  options.append(searchBox);
  const content = element('main', data.kind);
  const status = element('footer', 'status');
  app.replaceChildren(toolbar, options, content, status);
  return { controls, options, search, content, status };
}

function valueAt(signal: WaveSignal, time: number): string {
  let low = 0, high = signal.changes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (signal.changes[mid][0] <= time) low = mid + 1; else high = mid;
  }
  return low ? signal.changes[low - 1][1] : 'x';
}

function wavePreview(data: WaveData) {
  const ui = shell(data), labels = element('div', 'signal-labels'), scroller = element('div', 'wave-scroll');
  ui.content.append(labels, scroller);
  const radix = element('select');
  radix.setAttribute('aria-label', 'Value radix');
  for (const [value, name] of [['hex', 'Hex'], ['bin', 'Binary'], ['dec', 'Unsigned']]) {
    const option = element('option', '', name); option.value = value; radix.append(option);
  }
  const cursorLabel = element('output', 'cursor-value');
  ui.options.append(radix, cursorLabel);
  const hidden = new Set<string>();
  let zoom = 1, cursor = 0, canvas: SVGSVGElement, width = 1, rows: WaveSignal[] = [];
  const end = Math.max(data.endTime, 1);
  const unitIndex = ['s', 'ms', 'us', 'ns', 'ps', 'fs'].indexOf(data.unit);
  const seconds = end * data.timescale * 10 ** (-3 * unitIndex);
  const displayIndex = [0, 1, 2, 3, 4, 5].find(index => seconds >= 10 ** (-3 * index)) ?? 5;
  const displayUnit = ['s', 'ms', 'us', 'ns', 'ps', 'fs'][displayIndex];
  const timeText = (tick: number) => `${Number((tick * data.timescale * 10 ** (3 * (displayIndex - unitIndex))).toPrecision(6))} ${displayUnit}`;
  const valueText = (signal: WaveSignal, value: string) => {
    if (signal.type !== 'logic' || !/^[01]+$/.test(value)) return value;
    if (radix.value === 'bin') return value;
    const numeric = BigInt(`0b${value}`);
    return radix.value === 'dec' ? numeric.toString(10) : `0x${numeric.toString(16).toUpperCase()}`;
  };
  const values = new Map<WaveSignal, HTMLElement>();
  function updateCursor() {
    cursorLabel.textContent = `Cursor ${timeText(cursor)}`;
    for (const [signal, label] of values) {
      label.textContent = valueText(signal, valueAt(signal, cursor));
      label.title = label.textContent;
    }
    const line = canvas?.querySelector('[data-cursor]');
    line?.setAttribute('x1', String(cursor / end * width));
    line?.setAttribute('x2', String(cursor / end * width));
  }
  function draw() {
    const matches = data.signals.filter(signal => signal.name.toLowerCase().includes(ui.search.value.toLowerCase()));
    rows = matches.slice(0, 64);
    width = Math.max(scroller.clientWidth, 200) * zoom;
    canvas = svg('svg', { width, height: 34 + rows.length * 34, role: 'img', 'aria-label': 'Simulation waveform', tabindex: 0 });
    labels.replaceChildren(element('div', 'signal-heading', 'Signal / value'));
    values.clear();
    canvas.append(svg('rect', { width, height: 34, class: 'ruler-background' }));
    const divisions = Math.max(2, Math.floor(width / 110));
    for (let i = 0; i <= divisions; i++) {
      const x = i * width / divisions;
      canvas.append(svg('line', { x1: x, y1: 30, x2: x, y2: 34 + rows.length * 34, class: 'grid-line' }));
      if (i < divisions) canvas.append(svg('text', { x: x + 5, y: 20, class: 'axis-label' }, timeText(i * end / divisions)));
    }
    rows.forEach((signal, index) => {
      const row = element('label', 'signal-row');
      row.title = signal.name;
      const toggle = element('input');
      toggle.type = 'checkbox'; toggle.checked = !hidden.has(signal.name);
      toggle.setAttribute('aria-label', `Show ${signal.name}`);
      toggle.addEventListener('change', () => { toggle.checked ? hidden.delete(signal.name) : hidden.add(signal.name); draw(); });
      const name = element('span', 'signal-name', signal.name);
      const value = element('code', 'signal-value');
      values.set(signal, value);
      row.append(toggle, name, value); labels.append(row);
      const y = 34 + index * 34;
      canvas.append(svg('line', { x1: 0, y1: y + 34, x2: width, y2: y + 34, class: 'row-line' }));
      if (hidden.has(signal.name)) return;
      const changes: [number, string][] = signal.changes[0]?.[0] === 0 ? signal.changes : [[0, 'x'], ...signal.changes];
      let binaryPath = '', busPath = '', unknownPath = '', zPath = '', lastX = -1;
      for (let i = 0; i < changes.length; i++) {
        const [time, value] = changes[i], next = changes[i + 1]?.[0] ?? end;
        const x1 = time / end * width, x2 = next / end * width;
        if (x2 < lastX + 0.5 && i + 1 < changes.length) continue;
        lastX = x2;
        const high = y + 8, low = y + 26, mid = y + 17;
        if (signal.width === 1 && signal.type === 'logic' && (value === '0' || value === '1')) {
          const level = value === '1' ? high : low;
          binaryPath += `M${x1},${level}H${x2}`;
          const nextValue = changes[i + 1]?.[1];
          if ((nextValue === '0' || nextValue === '1') && nextValue !== value) binaryPath += `V${nextValue === '1' ? high : low}`;
        } else if (/^[xz]+$/i.test(value)) {
          if (/x/i.test(value)) unknownPath += `M${x1},${mid}H${x2}`;
          else zPath += `M${x1},${mid}H${x2}`;
        } else {
          const bevel = Math.min(4, (x2 - x1) / 2);
          busPath += `M${x1},${mid}L${x1 + bevel},${high}H${x2 - bevel}L${x2},${mid}L${x2 - bevel},${low}H${x1 + bevel}Z`;
          if (x2 - x1 > 58) {
            const label = valueText(signal, value), limit = Math.max(1, Math.floor((x2 - x1 - 12) / 7));
            canvas.append(svg('text', { x: (x1 + x2) / 2, y: mid + 4, 'text-anchor': 'middle', class: 'bus-label' }, label.length > limit ? `${label.slice(0, Math.max(1, limit - 3))}...` : label));
          }
        }
      }
      for (const [d, className] of [[binaryPath, 'logic-wave'], [busPath, 'bus-wave'], [unknownPath, 'unknown-wave'], [zPath, 'z-wave']]) {
        if (d) canvas.append(svg('path', { d, class: className }));
      }
    });
    canvas.append(svg('line', { 'data-cursor': '', x1: 0, x2: 0, y1: 30, y2: 34 + rows.length * 34, class: 'cursor-line' }));
    canvas.addEventListener('click', event => { cursor = Math.round(Math.max(0, Math.min(1, (event.clientX - canvas.getBoundingClientRect().left) / width)) * end); updateCursor(); });
    canvas.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault(); cursor = Math.min(end, Math.max(0, cursor + (event.key === 'ArrowRight' ? 1 : -1) * Math.max(1, Math.round(end / 100)))); updateCursor();
      }
    });
    scroller.replaceChildren(canvas);
    labels.scrollTop = scroller.scrollTop;
    ui.status.textContent = `${rows.length} / ${matches.length} matching signals | End ${timeText(data.endTime)} | ${data.timescale} ${data.unit} resolution${matches.length > 64 ? ' | Display limit: 64' : ''}`;
    updateCursor();
  }
  function zoomBy(factor: number, anchor = scroller.clientWidth / 2) {
    const next = Math.max(1, Math.min(32, zoom * factor));
    if (next === zoom) return;
    // Keep the time under the pointer fixed while the SVG changes width.
    const position = (scroller.scrollLeft + anchor) / width, top = scroller.scrollTop;
    zoom = next;
    draw();
    scroller.scrollLeft = position * width - anchor;
    scroller.scrollTop = top;
    labels.scrollTop = scroller.scrollTop;
  }
  ui.controls.append(
    button(ZoomOut, 'Zoom out', () => zoomBy(0.5)),
    button(ZoomIn, 'Zoom in', () => zoomBy(2)),
    button(Maximize, 'Fit waveform', () => { zoom = 1; scroller.scrollLeft = 0; draw(); }),
    button(ExternalLink, 'Open WDB in Vivado', () => vscode.postMessage({ type: 'external' })),
  );
  ui.search.addEventListener('input', draw);
  radix.addEventListener('change', draw);
  scroller.addEventListener('scroll', () => { labels.scrollTop = scroller.scrollTop; });
  scroller.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.shiftKey) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 34
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientWidth : 1;
    if (event.ctrlKey) {
      const anchor = Math.max(0, Math.min(scroller.clientWidth, event.clientX - scroller.getBoundingClientRect().left));
      zoomBy(2 ** (-event.deltaY * unit / 240), anchor);
    } else {
      // Some browsers/devices already translate Shift+wheel into deltaX.
      scroller.scrollLeft += (event.deltaY || event.deltaX) * unit;
    }
  }, { passive: false });
  const resize = new ResizeObserver(draw);
  resize.observe(scroller);
  release = () => resize.disconnect();
  draw();
}

async function circuitPreview(data: CircuitData, current: number) {
  const ui = shell(data);
  ui.content.textContent = 'Laying out synthesized netlist...';
  ui.status.textContent = `${data.part} | ${data.generatedAt}${data.stale ? ' | OUT OF DATE: run synthesis again' : ''}`;
  ui.status.classList.toggle('stale', !!data.stale);
  const { graph, edgeNets } = await layoutCircuit(data);
  if (generation !== current) return;
  const canvas = svg('svg', { width: '100%', height: '100%', role: 'img', 'aria-label': 'Synthesized circuit', tabindex: 0 });
  const scene = svg('g');
  canvas.append(scene); ui.content.replaceChildren(canvas);
  let scale = 1, offsetX = 0, offsetY = 0;
  const nodeElements = new Map<string, SVGGElement>(), edgeElements = new Map<string, SVGPathElement>();
  const detail = element('output', 'circuit-detail', `${data.nodes.length} cells / ports`);
  ui.options.append(detail);
  const apply = () => scene.setAttribute('transform', `translate(${offsetX},${offsetY}) scale(${scale})`);
  const fit = () => {
    scale = Math.min(1.5, Math.max(0.02, Math.min((ui.content.clientWidth - 32) / (graph.width || 1), (ui.content.clientHeight - 32) / (graph.height || 1))));
    offsetX = (ui.content.clientWidth - (graph.width || 0) * scale) / 2;
    offsetY = (ui.content.clientHeight - (graph.height || 0) * scale) / 2; apply();
  };
  const zoom = (factor: number, x = ui.content.clientWidth / 2, y = ui.content.clientHeight / 2) => {
    const next = Math.min(4, Math.max(0.02, scale * factor)), ratio = next / scale;
    offsetX = x - (x - offsetX) * ratio; offsetY = y - (y - offsetY) * ratio; scale = next; apply();
  };
  const select = (id?: string) => {
    const node = data.nodes.find(node => node.id === id), connected = new Set(node?.pins.map(pin => pin.net).filter(Boolean) || []);
    for (const [key, group] of nodeElements) group.classList.toggle('selected', key === id);
    for (const [key, edge] of edgeElements) edge.classList.toggle('connected', connected.has(edgeNets.get(key)!));
    detail.textContent = node ? `${node.name} : ${node.type}` : `${data.nodes.length} cells / ports`;
    detail.title = detail.textContent;
  };
  for (const edge of graph.edges || []) {
    let d = '';
    for (const section of edge.sections || []) {
      d += `M${section.startPoint.x},${section.startPoint.y}`;
      for (const point of [...(section.bendPoints || []), section.endPoint]) d += `L${point.x},${point.y}`;
    }
    const line = svg('path', { d, class: 'circuit-edge' });
    line.append(svg('title', {}, edgeNets.get(edge.id)));
    edgeElements.set(edge.id, line); scene.append(line);
  }
  for (const box of graph.children || []) {
    const node = data.nodes.find(node => node.id === box.id)!;
    const group = circuitSymbol(node, box);
    const activate = () => {
      select(node.id);
      if (node.port) vscode.postMessage({ type: 'planIo', port: node.name });
    };
    group.addEventListener('click', event => { event.stopPropagation(); activate(); });
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    nodeElements.set(node.id, group); scene.append(group);
  }
  let drag: { x: number; y: number; moved: boolean } | undefined;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('.circuit-node')) return;
    drag = { x: event.clientX, y: event.clientY, moved: false }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    offsetX += event.clientX - drag.x; offsetY += event.clientY - drag.y;
    drag.moved ||= Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 2;
    drag.x = event.clientX; drag.y = event.clientY; apply();
  });
  canvas.addEventListener('pointerup', event => { if (drag && !drag.moved) select(); drag = undefined; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); });
  canvas.addEventListener('pointercancel', () => { drag = undefined; });
  canvas.addEventListener('wheel', event => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
  ui.controls.append(
    button(ZoomOut, 'Zoom out', () => zoom(1 / 1.4)),
    button(ZoomIn, 'Zoom in', () => zoom(1.4)),
    button(Maximize, 'Fit circuit', fit),
    button(X, 'Clear selection', () => select()),
    button(TableProperties, 'I/O Planning', () => vscode.postMessage({ type: 'planIo' })),
    button(ExternalLink, 'Open project in Vivado', () => vscode.postMessage({ type: 'external' })),
  );
  const find = () => {
    const query = ui.search.value.toLowerCase();
    const matches = data.nodes.filter(node => node.name.toLowerCase().includes(query) || node.type.toLowerCase().includes(query));
    for (const node of data.nodes) nodeElements.get(node.id)?.classList.toggle('matched', !!query && matches.some(match => match.id === node.id));
    if (query) detail.textContent = `${matches.length} matches`;
    else select();
    return matches;
  };
  ui.search.addEventListener('input', find);
  ui.search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const node = find()[0], box = graph.children?.find(box => box.id === node?.id);
    if (!box) return;
    scale = 1; offsetX = ui.content.clientWidth / 2 - box.x! - box.width! / 2;
    offsetY = ui.content.clientHeight / 2 - box.y! - box.height! / 2; apply(); select(node.id);
  });
  const resize = new ResizeObserver(fit);
  resize.observe(ui.content);
  release = () => resize.disconnect();
  fit();
}

window.addEventListener('message', async event => {
  if (event.data?.type !== 'data' && event.data?.type !== 'status') return;
  const current = ++generation;
  release(); release = () => {};
  if (event.data.type === 'status') {
    const message = element('p', 'message', String(event.data.message || 'No current simulation results.'));
    message.setAttribute('role', 'status');
    app.replaceChildren(message);
    return;
  }
  try {
    const data: PreviewData = event.data.data;
    if (data.kind === 'waveform') wavePreview(data);
    else if (data.kind === 'schematic') await circuitPreview(data, current);
    else if (data.kind === 'ioPlanning') release = ioPreview(data, shell(data), message => vscode.postMessage(message));
  } catch (error) {
    if (generation !== current) return;
    app.replaceChildren(element('p', 'message error', String(error instanceof Error ? error.message : error)),
      button(ExternalLink, 'Open in Vivado', () => vscode.postMessage({ type: 'external' })));
  }
});
vscode.postMessage({ type: 'ready' });
