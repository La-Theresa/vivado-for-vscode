import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { parseWaveform, readWaveform } from '../src/sim/waveform';
import { parseSchematic } from '../src/build/schematic';
import { previewHtml } from '../src/views/previewHtml';
import { parseIoQuery } from '../src/io/planner';
import { IoData } from '../src/views/previewModel';

async function checkWaveNavigation(page: Page, screenshot: string) {
  const scroller = page.locator('.wave-scroll');
  const image = page.getByRole('img', { name: 'Simulation waveform' });
  const width = async () => Number(await image.getAttribute('width'));
  const left = () => scroller.evaluate(node => node.scrollLeft);
  const initial = await width(), cursor = await page.locator('.cursor-value').innerText();
  const bounds = (await scroller.boundingBox())!;
  const anchor = bounds.width * 0.4;
  await page.mouse.move(bounds.x + anchor, bounds.y + 45);
  await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, -240); } finally { await page.keyboard.up('Control'); }
  await expect.poll(width).toBeGreaterThan(initial);
  const enlarged = await width();
  assert.ok(Math.abs((await left() + anchor) / enlarged - anchor / initial) * enlarged < 2, 'Ctrl+wheel anchors the time under the mouse.');
  assert.equal(await page.locator('.cursor-value').innerText(), cursor);
  assert.equal(await page.evaluate(() => window.visualViewport?.scale), 1, 'Only the waveform zooms, not the whole page.');

  const beforePan = await left(), top = await scroller.evaluate(node => node.scrollTop);
  await page.keyboard.down('Shift');
  try { await page.mouse.wheel(0, 70); } finally { await page.keyboard.up('Shift'); }
  await expect.poll(left).toBeGreaterThan(beforePan);
  const afterPan = await left();
  await page.keyboard.down('Shift');
  try { await page.mouse.wheel(0, -35); } finally { await page.keyboard.up('Shift'); }
  await expect.poll(left).toBeLessThan(afterPan);
  assert.equal(await width(), enlarged);
  assert.equal(await scroller.evaluate(node => node.scrollTop), top);
  assert.equal(await page.locator('.cursor-value').innerText(), cursor);
  await page.screenshot({ path: screenshot });

  const beforeZoomOut = await left();
  await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, 60); } finally { await page.keyboard.up('Control'); }
  await expect.poll(width).toBeLessThan(enlarged);
  assert.ok(Math.abs((await left() + anchor) / await width() - (beforeZoomOut + anchor) / enlarged) * await width() < 2);

  const wheel = (options: Pick<WheelEventInit, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey'>) => scroller.evaluate((node, options) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
    node.dispatchEvent(event); return event.defaultPrevented;
  }, options);
  assert.equal(await wheel({ deltaY: -100000, ctrlKey: true }), true);
  assert.equal(await width(), initial * 32, 'Zoom is capped at 32x.');
  assert.equal(await wheel({ deltaY: -240, ctrlKey: true }), true);
  assert.equal(await width(), initial * 32);
  await scroller.evaluate(node => { node.scrollLeft = 0; });
  await wheel({ deltaY: 2, deltaMode: 1, shiftKey: true });
  assert.equal(await left(), 68, 'Line deltas use waveform row height.');
  await wheel({ deltaX: 45, shiftKey: true });
  assert.equal(await left(), 113, 'Already-horizontal wheel deltas are accepted.');
  const viewport = await scroller.evaluate(node => node.clientWidth);
  await wheel({ deltaY: 1, deltaMode: 2, shiftKey: true });
  assert.equal(await left(), 113 + viewport, 'Page deltas use the viewport width.');
  const position = await left();
  assert.equal(await wheel({ deltaY: 80 }), false, 'Unmodified wheel retains native scrolling.');
  assert.equal(await left(), position);
  await wheel({ deltaY: -100000, shiftKey: true });
  assert.equal(await left(), 0);
  await wheel({ deltaY: 100000, shiftKey: true });
  assert.equal(await left(), await scroller.evaluate(node => node.scrollWidth - node.clientWidth));
  await wheel({ deltaY: 100000, ctrlKey: true });
  assert.equal(await width(), initial, 'Zoom cannot go below Fit.');
  await wheel({ deltaY: 240, ctrlKey: true });
  assert.equal(await width(), initial);
  await wheel({ deltaY: -2, deltaMode: 1, ctrlKey: true });
  assert.ok(await width() > initial, 'Ctrl+wheel also normalizes line deltas.');
  await wheel({ deltaY: -1, deltaMode: 2, ctrlKey: true });
  assert.ok(await width() > initial * 2, 'Ctrl+wheel also normalizes page deltas.');
  await page.getByRole('button', { name: 'Fit waveform' }).click();
  assert.equal(await left(), 0);
}

async function main() {
  const root = path.resolve('.test-work/preview-browser');
  await fs.mkdir(root, { recursive: true });
  const wasm = path.resolve('node_modules/rust_vcd_wasm/rust_vcd_wasm_bg.wasm');
  const vcdFile = process.argv.find(arg => arg.startsWith('--vcd='))?.slice(6);
  const schematicFile = process.argv.find(arg => arg.startsWith('--schematic='))?.slice(12);
  const ioFile = process.argv.find(arg => arg.startsWith('--io='))?.slice(5);
  const wave = vcdFile ? await readWaveform(vcdFile, wasm) : await parseWaveform(`$timescale 1 ns $end
$scope module tb $end
$var reg 1 ! clk $end
$var wire 4 " result [3:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b0000 "
#10
1!
b0010 "
#20
0!
b10xz "
#30
1!
b1111 "
#40
0!
#50
`, 'wave.vcd', wasm);
  const circuit = parseSchematic(schematicFile ? await fs.readFile(schematicFile, 'utf8') : `<netlist top="top" part="xc7a35tcsg324-1" generatedAt="test">
<cell name="logic_gate" type="LUT2"><property name="INIT" value="4'h8"/><pin name="I0" direction="IN" net="a"/><pin name="I1" direction="IN" net="b"/><pin name="O" direction="OUT" net="f"/></cell>
<port name="A" direction="IN" net="a"/><port name="B" direction="IN" net="b"/><port name="F" direction="OUT" net="f"/>
<count value="1"/></netlist>`, schematicFile || 'schematic.xml');
  const io: IoData = { kind: 'ioPlanning', title: 'top', source: 'top.dcp', part: 'xc7a35tcsg324-1', generatedAt: 'test', revision: 'test', constraintFile: 'constraints/io-planning.xdc',
    ...parseIoQuery(ioFile ? await fs.readFile(ioFile, 'utf8') : `<io part="xc7a35tcsg324-1">
<pin name="A1" bank="14" function="IO_L1P_T0" clock="1" mate="A2"/><pin name="A2" bank="14" function="IO_L1N_T0" clock="0" mate="A1"/>
<pin name="B1" bank="15" function="IO_0_15" clock="0" mate=""/><pin name="B2" bank="15" function="IO_1_15" clock="0" mate=""/>
<bank name="14" type="BT_HIGH_RANGE" standards="LVCMOS18 LVCMOS33"/><bank name="15" type="BT_HIGH_RANGE" standards="LVCMOS18 LVCMOS33"/>
<standard name="LVCMOS18" directions="INPUT OUTPUT BIDIR" vccoIn="1.8" vccoOut="1.8"/><standard name="LVCMOS33" directions="INPUT OUTPUT BIDIR" vccoIn="3.3" vccoOut="3.3"/>
<port name="clk" direction="IN" pin="A1" standard="LVCMOS18"/><port name="led[0]" direction="OUT" pin="B1" standard="LVCMOS18"/><port name="sw[0]" direction="IN" pin="" standard="DEFAULT"/>
</io>`, 'xc7a35tcsg324-1'),
  };
  const html = path.join(root, 'preview.html');
  await fs.writeFile(html, previewHtml(pathToFileURL(path.resolve('dist/preview.js')).href, pathToFileURL(path.resolve('dist/preview.css')).href, 'file:', 'test-nonce'));
  const browser = await chromium.launch({ channel: process.env.PREVIEW_BROWSER || 'chrome', headless: true });
  try {
    for (const size of [{ width: 1100, height: 720 }, { width: 360, height: 740 }]) {
      for (const data of [wave, circuit, io]) {
        const page = await browser.newPage({ viewport: size });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.addInitScript({ content: `window.previewMessages = []; window.previewPayloads = [];
        window.acquireVsCodeApi = function () {
          return { postMessage: function (message) {
            window.previewMessages.push(message.type);
            window.previewPayloads.push(message);
            if (message.type === "ready") setTimeout(function () {
              window.postMessage({ type: "data", data: ${JSON.stringify(data)} }, "*");
            }, 0);
          } };
        };` });
        await page.goto(pathToFileURL(html).href);
        const image = data.kind === 'ioPlanning' ? page.getByRole('table', { name: 'I/O port assignments' }) : page.getByRole('img', { name: data.kind === 'waveform' ? 'Simulation waveform' : 'Synthesized circuit' });
        try { await image.waitFor({ timeout: 30000 }); }
        catch (error) { console.error('Preview errors:', errors, await page.locator('body').innerText()); throw error; }
        assert.equal(await page.locator('.error').count(), 0);
        if (data.kind === 'waveform') {
          assert.ok(await page.locator('.logic-wave, .bus-wave, .unknown-wave').count() > 0);
          const before = await image.getAttribute('width');
          await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
          assert.ok(Number(await image.getAttribute('width')) > Number(before));
          await page.getByRole('button', { name: 'Fit waveform' }).click();
          await image.click({ position: { x: 80, y: 45 } });
          assert.doesNotMatch(await page.locator('.cursor-value').innerText(), /^Cursor 0 /);
          await checkWaveNavigation(page, path.join(root, `waveform-wheel-${size.width}.png`));
          await page.getByRole('searchbox').fill(data.signals[0].name);
          assert.ok(await page.locator('.signal-row').count() >= 1);
          await page.getByRole('searchbox').fill('');
          await page.getByRole('combobox', { name: 'Value radix' }).selectOption('bin');
          const checkbox = page.getByRole('checkbox').first();
          await checkbox.uncheck();
          assert.equal(await page.getByRole('checkbox').first().isChecked(), false);
          await page.getByRole('checkbox').first().check();
        } else if (data.kind === 'schematic') {
          assert.equal(await page.locator('.circuit-node').count(), data.nodes.length);
          assert.ok(await page.locator('.circuit-edge').count() > 0);
          await page.locator('.circuit-node').first().click();
          assert.equal(await page.locator('.circuit-node.selected').count(), 1);
          assert.ok(await page.locator('.circuit-edge.connected').count() > 0);
          await page.getByRole('searchbox').fill(data.nodes[0].name);
          await page.getByRole('searchbox').press('Enter');
          assert.ok(await page.locator('.circuit-node.matched').count() > 0);
          await page.getByRole('searchbox').fill('');
          const before = await image.locator(':scope > g').getAttribute('transform');
          await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
          assert.notEqual(await image.locator(':scope > g').getAttribute('transform'), before);
          await page.getByRole('button', { name: 'Fit circuit' }).click();
          const fitted = await image.locator(':scope > g').getAttribute('transform');
          const bounds = (await image.boundingBox())!;
          await page.mouse.move(bounds.x + 4, bounds.y + 4);
          await page.mouse.down();
          await page.mouse.move(bounds.x + 44, bounds.y + 34, { steps: 4 });
          await page.mouse.up();
          assert.notEqual(await image.locator(':scope > g').getAttribute('transform'), fitted);
          await page.getByRole('button', { name: 'Fit circuit' }).click();
          assert.ok(await page.locator('.symbol-body, .symbol-line').count() > 0);
          if (!schematicFile) assert.equal(await page.locator('[data-symbol="and"]').count(), 1);
          await page.getByRole('button', { name: 'I/O Planning', exact: true }).click();
          assert.equal(await page.evaluate('window.previewMessages.includes("planIo")'), true);
          await page.locator('.port-node').first().click();
          assert.equal(await page.evaluate('window.previewPayloads.some(message => message.type === "planIo" && !!message.port)'), true);
        } else {
          assert.equal(await image.locator('tbody tr').count(), data.ports.length);
          const port = data.ports[0], original = port.packagePin;
          const input = page.getByRole('textbox', { name: `Package pin for ${port.name}`, exact: true });
          const save = page.getByRole('button', { name: 'Save Constraints' });
          await input.fill('NOT_A_PIN');
          assert.equal(await save.isDisabled(), true);
          assert.match(await page.locator('.io-validation').innerText(), /not a bonded/);
          await input.fill(original);
          const occupied = data.ports.find(other => other.name !== port.name && other.packagePin);
          if (occupied) {
            await input.fill(occupied.packagePin);
            assert.match(await page.locator('.io-validation').innerText(), /assigned to both/);
            await input.fill(original);
          }
          const unused = data.pins.find(pin => !data.ports.some(port => port.packagePin === pin.name))!;
          await page.getByRole('button', { name: `Choose package pin for ${port.name}`, exact: true }).click();
          const picker = page.getByRole('dialog');
          assert.equal(await picker.isVisible(), true);
          if (occupied) assert.equal(await picker.getByRole('button', { name: `Select pin ${occupied.packagePin}`, exact: true }).isDisabled(), true);
          await picker.getByRole('combobox', { name: 'Filter bank' }).selectOption(unused.bank);
          await picker.getByRole('searchbox', { name: 'Filter package pins' }).fill(unused.name);
          await page.screenshot({ path: path.join(root, `pin-picker-${size.width}.png`) });
          await picker.getByRole('button', { name: `Select pin ${unused.name}`, exact: true }).click();
          assert.equal(await input.inputValue(), unused.name);
          const standard = page.getByRole('combobox', { name: `I/O standard for ${port.name}`, exact: true });
          const allowed = await standard.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
          await standard.selectOption(allowed.find(value => value === 'LVCMOS18') || allowed[0]);
          assert.equal(await save.isDisabled(), false);
          await save.click();
          const sent = await page.evaluate('window.previewPayloads.findLast(message => message.type === "ioSave")') as { assignments: { name: string; packagePin: string; ioStandard: string }[]; revision: string };
          assert.equal(sent.revision, data.revision);
          assert.equal(sent.assignments.find(row => row.name === port.name)?.packagePin, unused.name);
          await page.evaluate(() => window.postMessage({ type: 'ioResult', error: 'Project changed. Reload I/O Planning.' }, '*'));
          await page.getByText('Project changed. Reload I/O Planning.').waitFor();
          assert.equal(await input.inputValue(), unused.name);
          await save.click();
          await page.evaluate(next => window.postMessage({ type: 'data', data: next }, '*'), { ...data, ports: data.ports.map(port => ({ ...port, ...sent.assignments.find(row => row.name === port.name) })) });
          await page.getByText(data.constraintFile, { exact: false }).waitFor();
          assert.doesNotMatch(await page.locator('.io-summary').innerText(), /Unsaved/);
          await page.evaluate(name => window.postMessage({ type: 'ioFocus', port: name }, '*'), data.ports.at(-1)!.name);
          assert.equal(await page.locator('.selected-row').count(), 1);
          await page.getByRole('searchbox', { name: 'Filter ports' }).fill(port.name);
          assert.ok(await image.locator('tbody tr:visible').count() >= 1);
          await page.getByRole('searchbox', { name: 'Filter ports' }).fill('');
          await page.evaluate(() => window.postMessage({ type: 'ioStale', error: 'Project part changed. Run Synthesize, then Reload I/O Planning.' }, '*'));
          await page.getByText('Project part changed. Run Synthesize, then Reload I/O Planning.').waitFor();
          assert.equal(await save.isDisabled(), true);
          assert.equal(await input.isDisabled(), true);
          await page.getByRole('button', { name: 'Reload I/O Planning' }).click();
          assert.equal(await page.evaluate('window.previewMessages.includes("ioReload")'), true);
          await page.evaluate(next => window.postMessage({ type: 'data', data: next }, '*'), data);
          await page.waitForFunction(() => !(document.querySelector('.pin-input') as HTMLInputElement)?.disabled);
          await page.locator('main').evaluate(node => { node.scrollLeft = 0; node.scrollTop = 0; });
        }
        if (data.kind !== 'ioPlanning') {
          await page.getByRole('button', { name: data.kind === 'waveform' ? 'Open WDB in Vivado' : 'Open project in Vivado' }).click();
          assert.equal(await page.evaluate('window.previewMessages.includes("external")'), true);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
        const screenshot = path.join(root, `${data.kind}-${size.width}.png`);
        await page.screenshot({ path: screenshot });
        console.log(`PASS ${data.kind} ${size.width}x${size.height}: ${screenshot}`);
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
