import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { checkedNotices, validateNotices, verifyWasmArtifact } from '../scripts/build-wasm.mjs';
import { readToml, lockedPackages } from '../scripts/wasm-tools.mjs';

test('self-built binary has a verified receipt, ABI and no host imports', async () => {
  const receipt = await verifyWasmArtifact();
  assert.equal(receipt.rustVersion, '1.85.1');
  const module = await WebAssembly.compile(await fs.readFile('dist/vivado_vcd_parser.wasm'));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  for (const name of ['memory', 'vcd_alloc', 'vcd_parse', 'vcd_free', 'vcd_abi_version']) {
    assert.ok(WebAssembly.Module.exports(module).some(value => value.name === name));
  }
  const parser = new WebAssembly.Instance(module).exports;
  for (let repeat = 0; repeat < 100; repeat++) {
    const input = Buffer.from('$timescale 1 ns $end\n$var wire 1 ! clk $end\n$enddefinitions $end\n#0 0! #5 1!' + ' '.repeat(repeat));
    const pointer = parser.vcd_alloc(input.length);
    new Uint8Array(parser.memory.buffer, pointer, input.length).set(input);
    const output = parser.vcd_parse(pointer, input.length);
    const length = new DataView(parser.memory.buffer).getUint32(output, true);
    const result = JSON.parse(Buffer.from(parser.memory.buffer, output + 4, length).toString('utf8'));
    assert.deepEqual(result.data.timelines[0], [[0, '0'], [5, '1']]);
    parser.vcd_free(pointer, input.length);
    parser.vcd_free(output, length + 4);
  }
});

test('release gate rejects missing, altered and stale Rust license evidence', async () => {
  const notices = await checkedNotices();
  const lock = await fs.readFile('wasm/vcd-parser/Cargo.lock');
  const packages = lockedPackages(await readToml('wasm/vcd-parser/Cargo.lock'));
  const verify = value => validateNotices(value, '1.85.1', lock, packages);
  for (const mutate of [
    value => { value.components = value.components.filter(item => item.name !== 'vcd'); },
    value => { value.components = value.components.filter(item => item.name !== 'Rust toolchain runtime'); },
    value => { value.applicationLockSha256 = '0'.repeat(64); },
    value => { value.texts[Object.keys(value.texts)[0]] += ' altered'; },
    value => { value.components[0].licenses = []; },
    value => { value.runtime = []; },
  ]) {
    const copy = structuredClone(notices);
    mutate(copy);
    assert.throws(() => verify(copy));
  }
});
