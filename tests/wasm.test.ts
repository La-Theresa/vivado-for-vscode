import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseWaveform } from '../src/sim/waveform';

const wasm = path.resolve('dist/vivado_vcd_parser.wasm');
const wave = (body: string, declarations = '$var wire 1 ! clk $end', scale = '1 ns') =>
  `$timescale ${scale} $end\n$scope module tb $end\n${declarations}\n$upscope $end\n$enddefinitions $end\n${body}`;
const parse = (content: string) => parseWaveform(content, 'wave.vcd', wasm);

test('WASM handles compact VCD, EOF, same-time overwrite and repeated values', async () => {
  const result = await parse(wave('#0 0! #5 1! 0! 1! #6 1! #10 0!'));
  assert.deepEqual(result.signals[0].changes, [[0, '0'], [5, '1'], [10, '0']]);
  assert.equal(result.endTime, 10);
  assert.equal((await parse(wave('#0 0! #25'))).endTime, 25);
});

test('aliases share one timeline and logic buses preserve X/Z extension', async () => {
  const result = await parse(wave('#0 bX ! #1 bZ ! #2 b1 ! #3 b10XZ !',
    '$var wire 8 ! data [7:0] $end\n$scope module dut $end\n$var wire 8 ! data_alias [7:0] $end\n$upscope $end'));
  assert.strictEqual(result.signals[0].changes, result.signals[1].changes);
  assert.deepEqual(result.signals[0].changes, [[0, 'xxxxxxxx'], [1, 'zzzzzzzz'], [2, '00000001'], [3, '000010xz']]);
  assert.equal(result.signals[0].name, 'tb.data');
  assert.equal(result.signals[1].name, 'tb.dut.data_alias');
});

test('bit selects, real values, strings and timescale retain their metadata', async () => {
  const result = await parse(wave('#0 1! r1.25 " sready #\n#3 r-2.5 " sdone #',
    '$var wire 1 ! bit [2] $end\n$var real 64 " analog $end\n$var string 1 # state $end', '10 ps'));
  assert.equal(result.timescale, 10);
  assert.equal(result.unit, 'ps');
  assert.equal(result.signals[0].name, 'tb.bit[2]');
  assert.equal(result.signals[1].type, 'real');
  assert.deepEqual(result.signals[1].changes, [[0, '1.25'], [3, '-2.5']]);
  assert.equal(result.signals[2].type, 'string');
  assert.deepEqual(result.signals[2].changes, [[0, 'ready'], [3, 'done']]);
});

test('invalid VCD is rejected and later parses still work', async () => {
  for (const invalid of [
    '',
    '$enddefinitions $end',
    wave('#0 0?'),
    wave('#2 0! #1 1!'),
    wave('#9007199254740992 0!'),
    wave('#0 b10 !'),
    wave('#0 r1 !'),
    wave('#0 0!', '$var wire 1 ! a $end\n$var wire 2 ! alias $end'),
    wave('#0 0!', '$var wire 0 ! a $end'),
    wave('#0 0!', '$var wire 4097 ! a $end'),
    wave('#0 0!', '$scope module incomplete $end\n$var wire 1 ! a $end'),
  ]) {
    await assert.rejects(parse(invalid));
    assert.deepEqual((await parse(wave('#0 0! #1 1!'))).signals[0].changes, [[0, '0'], [1, '1']]);
  }
});

test('preview limits fail with actionable errors instead of hanging', async () => {
  await assert.rejects(parse(wave('#0 0!\n'.repeat(500001))), /500000 changes/);
  const signals = Array.from({ length: 2049 }, (_, index) => `$var wire 1 ! a${index} $end`).join('\n');
  await assert.rejects(parse(wave('#0 0!', signals)), /2048 signals/);
  const deep = '$scope module a $end\n'.repeat(65) + '$var wire 1 ! a $end\n' + '$upscope $end\n'.repeat(65);
  await assert.rejects(parse(wave('#0 0!', deep)), /hierarchy/);
  await assert.rejects(parse(wave('#0\n' + 'bx !\n'.repeat(8200), '$var wire 4096 ! a $end')), /expanded preview limit/);
});

test('counter fixture has exact transitions, not just a nonempty waveform', async () => {
  const samples: string[] = ['#0', '0!', 'b0000 "'];
  const clock: [number, string][] = [[0, '0']];
  const counter: [number, string][] = [[0, '0000']];
  for (let edge = 1; edge <= 2000; edge++) {
    const time = edge * 5;
    samples.push(`#${time}`, `${edge % 2}!`);
    clock.push([time, String(edge % 2)]);
    if (edge % 2) {
      const bits = (((edge + 1) / 2) % 16).toString(2).padStart(4, '0');
      samples.push(`b${bits} "`);
      counter.push([time, bits]);
    }
  }
  const result = await parse(wave(samples.join('\n'), '$var wire 1 ! clk $end\n$var reg 4 " count [3:0] $end'));
  assert.equal(result.endTime, 10000);
  assert.deepEqual(result.signals[0].changes, clock);
  assert.deepEqual(result.signals[1].changes, counter);
});
