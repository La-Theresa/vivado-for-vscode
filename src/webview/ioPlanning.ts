import { createElement, List, RefreshCw, Save, X } from 'lucide';
import type { IconNode } from 'lucide';
import { IoAssignment, IoData, IoPort } from '../views/previewModel';
import { validateIoAssignments } from '../io/validation';

interface IoShell { controls: HTMLElement; options: HTMLElement; search: HTMLInputElement; content: HTMLElement; status: HTMLElement }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function icon(icon: IconNode, title: string, action: () => void) {
  const node = el('button', 'icon-button');
  node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
  node.append(createElement(icon, { width: 17, height: 17, 'aria-hidden': 'true' }));
  node.addEventListener('click', action); return node;
}

export function ioPreview(data: IoData, ui: IoShell, post: (message: unknown) => void): () => void {
  const assignments: IoAssignment[] = data.ports.map(port => ({ name: port.name, packagePin: port.packagePin, ioStandard: port.ioStandard }));
  const pins = new Map(data.pins.map(pin => [pin.name, pin]));
  const rows = new Map<string, HTMLTableRowElement>();
  const editors = new Map<string, { pin: HTMLInputElement; standard: HTMLSelectElement; bank: HTMLElement; detail: HTMLElement }>();
  const device = el('span', 'device-label', data.part);
  const validation = el('div', 'io-validation');
  validation.setAttribute('aria-live', 'polite');
  const message = el('div', 'io-message');
  message.setAttribute('role', 'status');
  let dirty = false, busy = false, stale = data.stale, dialog: HTMLDialogElement | undefined;
  const save = icon(Save, 'Save Constraints', () => {
    if (busy || stale || validateIoAssignments(data, assignments).errors.length) return;
    busy = true; update(); post({ type: 'ioSave', assignments, revision: data.revision });
  });
  const reload = icon(RefreshCw, 'Reload I/O Planning', () => { if (!busy) { busy = true; update(); post({ type: 'ioReload', dirty }); } });
  ui.controls.append(save, reload);
  ui.options.append(device);
  const table = el('table', 'io-table');
  table.setAttribute('aria-label', 'I/O port assignments');
  const head = el('thead'), headings = el('tr');
  for (const title of ['Port', 'Direction', 'Package Pin', 'Bank', 'Pin Function', 'I/O Standard']) {
    const heading = el('th', '', title); heading.scope = 'col'; headings.append(heading);
  }
  head.append(headings);
  const body = el('tbody');
  table.append(head, body); ui.content.append(table);
  const summary = el('div', 'io-summary');
  const warning = el('div', 'io-board-warning', 'Board voltages, differential pairing and timing are not verified.');
  ui.status.append(message, validation, summary, warning);

  function updateStandards(port: IoPort, assignment: IoAssignment) {
    const editor = editors.get(port.name)!, pin = pins.get(assignment.packagePin.trim().toUpperCase());
    editor.bank.textContent = pin?.bank || '';
    editor.detail.textContent = pin ? `${pin.function}${pin.clock ? ' / CLK' : ''}` : '';
    editor.detail.title = pin?.differentialMate ? `Differential mate: ${pin.differentialMate}` : editor.detail.textContent;
    const bank = data.banks.find(bank => bank.name === pin?.bank);
    const direction = { IN: 'INPUT', OUT: 'OUTPUT', INOUT: 'BIDIR' }[port.direction];
    const standards = data.standards.filter(standard => standard.directions.includes(direction) && (!bank || bank.standards.includes(standard.name)));
    editor.standard.replaceChildren(new Option('Unassigned', ''));
    for (const standard of standards) editor.standard.append(new Option(standard.name, standard.name));
    if (assignment.ioStandard && !standards.some(standard => standard.name === assignment.ioStandard)) {
      editor.standard.append(new Option(`${assignment.ioStandard} (unsupported)`, assignment.ioStandard));
    }
    editor.standard.value = assignment.ioStandard;
  }
  function update() {
    const checked = validateIoAssignments(data, assignments);
    validation.replaceChildren();
    for (const text of checked.errors.slice(0, 4)) validation.append(el('div', 'error', text));
    for (const text of checked.warnings.slice(0, 3)) validation.append(el('div', 'warning', text));
    if (checked.errors.length > 4) validation.append(el('div', 'error', `${checked.errors.length} errors total`));
    summary.textContent = `${assignments.filter(port => port.packagePin).length} / ${data.ports.length} pins assigned | ${dirty ? 'Unsaved changes' : data.constraintFile}`;
    if (stale) { message.textContent = stale; message.classList.add('error'); }
    save.disabled = busy || !!stale || checked.errors.length > 0;
    reload.disabled = busy;
    for (const input of ui.content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) input.disabled = busy || !!stale;
    for (const [name, editor] of editors) {
      const assignment = assignments.find(port => port.name === name)!;
      const normalized = assignment.packagePin.trim().toUpperCase();
      const invalid = !!normalized && (!pins.has(normalized) || assignments.some(other => other.name !== name && other.packagePin.trim().toUpperCase() === normalized));
      editor.pin.setAttribute('aria-invalid', String(invalid));
    }
  }
  function changed(port: IoPort, assignment: IoAssignment) {
    dirty = true; message.textContent = ''; updateStandards(port, assignment); update();
  }
  function pick(port: IoPort, assignment: IoAssignment) {
    if (busy || stale) return;
    dialog?.remove();
    dialog = el('dialog', 'pin-picker');
    dialog.setAttribute('aria-label', `Package pins for ${data.part}`);
    const title = el('header', 'toolbar');
    title.append(el('strong', 'title', `${port.name} - ${data.part}`), icon(X, 'Close pin list', () => dialog?.close()));
    const options = el('div', 'options');
    const search = el('input', 'pin-search'); search.type = 'search'; search.placeholder = 'Pin or function'; search.setAttribute('aria-label', 'Filter package pins');
    const bank = el('select'); bank.setAttribute('aria-label', 'Filter bank');
    bank.append(new Option('All banks', ''));
    for (const name of [...new Set(data.pins.map(pin => pin.bank))].sort()) bank.append(new Option(`Bank ${name}`, name));
    options.append(search, bank);
    const list = el('div', 'pin-list'), pinTable = el('table', 'io-table'), pinHead = el('thead'), tr = el('tr');
    for (const text of ['Pin', 'Bank', 'Function', 'Assigned Port']) { const th = el('th', '', text); th.scope = 'col'; tr.append(th); }
    pinHead.append(tr);
    const pinBody = el('tbody');
    pinTable.append(pinHead, pinBody); list.append(pinTable);
    const count = el('footer', 'status');
    dialog.append(title, options, list, count); document.body.append(dialog);
    const render = () => {
      pinBody.replaceChildren();
      const query = search.value.toLowerCase();
      const matches = data.pins.filter(pin => (!bank.value || pin.bank === bank.value) && `${pin.name} ${pin.function}`.toLowerCase().includes(query));
      for (const pin of matches) {
        const row = el('tr'), cell = el('td');
        const occupied = assignments.find(other => other.name !== port.name && other.packagePin.trim().toUpperCase() === pin.name);
        const choice = el('button', 'pin-choice', pin.name);
        choice.type = 'button'; choice.disabled = !!occupied; choice.setAttribute('aria-label', `Select pin ${pin.name}`);
        if (occupied) choice.title = `Assigned to ${occupied.name}`;
        choice.addEventListener('click', () => {
          assignment.packagePin = pin.name; editors.get(port.name)!.pin.value = pin.name;
          changed(port, assignment); dialog?.close(); editors.get(port.name)!.pin.focus();
        });
        cell.append(choice); row.append(cell, el('td', '', pin.bank), el('td', '', `${pin.function}${pin.clock ? ' / CLK' : ''}`), el('td', '', occupied?.name || ''));
        pinBody.append(row);
      }
      count.textContent = `${matches.length} / ${data.pins.length} package pins`;
    };
    search.addEventListener('input', render); bank.addEventListener('change', render);
    render(); dialog.showModal(); search.focus();
  }
  data.ports.forEach((port, index) => {
    const assignment = assignments[index], row = el('tr');
    row.dataset.port = port.name;
    if (port.name === data.selectedPort) row.classList.add('selected-row');
    const name = el('th', 'port-name', port.name); name.scope = 'row'; name.title = port.name;
    const direction = el('td', '', port.direction), pinCell = el('td'), pinControls = el('div', 'pin-controls');
    const pin = el('input', 'pin-input');
    pin.type = 'text'; pin.value = assignment.packagePin; pin.maxLength = 20; pin.autocomplete = 'off';
    pin.setAttribute('aria-label', `Package pin for ${port.name}`);
    pin.addEventListener('input', () => { assignment.packagePin = pin.value; changed(port, assignment); });
    pin.addEventListener('blur', () => { assignment.packagePin = assignment.packagePin.trim().toUpperCase(); pin.value = assignment.packagePin; });
    pinControls.append(pin, icon(List, `Choose package pin for ${port.name}`, () => pick(port, assignment))); pinCell.append(pinControls);
    const bank = el('td'), detail = el('td', 'pin-function'), standardCell = el('td'), standard = el('select');
    standard.setAttribute('aria-label', `I/O standard for ${port.name}`);
    standard.addEventListener('change', () => { assignment.ioStandard = standard.value; changed(port, assignment); });
    standardCell.append(standard);
    editors.set(port.name, { pin, standard, bank, detail });
    updateStandards(port, assignment);
    row.append(name, direction, pinCell, bank, detail, standardCell); body.append(row); rows.set(port.name, row);
  });
  ui.search.addEventListener('input', () => {
    for (const [name, row] of rows) row.hidden = !name.toLowerCase().includes(ui.search.value.toLowerCase());
  });
  const receive = (event: MessageEvent) => {
    if (event.data?.type === 'ioStale' && typeof event.data.error === 'string') {
      stale = event.data.error; dialog?.close(); update();
    }
    if (event.data?.type === 'ioResult') {
      busy = false;
      message.textContent = event.data.error || (event.data.cancelled ? 'Cancelled' : '');
      message.classList.toggle('error', !!event.data.error);
      update();
    }
    if (event.data?.type === 'ioFocus' && typeof event.data.port === 'string') {
      ui.search.value = '';
      for (const [name, row] of rows) { row.hidden = false; row.classList.toggle('selected-row', name === event.data.port); }
      rows.get(event.data.port)?.scrollIntoView({ block: 'center' });
      editors.get(event.data.port)?.pin.focus();
    }
  };
  window.addEventListener('message', receive);
  update();
  if (data.selectedPort) requestAnimationFrame(() => {
    rows.get(data.selectedPort!)?.scrollIntoView({ block: 'center' }); editors.get(data.selectedPort!)?.pin.focus();
  });
  return () => { window.removeEventListener('message', receive); dialog?.remove(); };
}
