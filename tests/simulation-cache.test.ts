import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, validateConfig, writeConfig } from '../src/project/config';
import { clearSimulationCache, readSimulation, simulate } from '../src/sim/simulator';
import { Toolchain } from '../src/toolchain/detect';
import { CancelledError } from '../src/toolchain/process';

async function previousRun(root: string): Promise<string> {
  const directory = path.join(root, '.vivado/sim/run-old');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'wave.vcd'), 'old waveform');
  await fs.writeFile(path.join(root, '.vivado/sim/last-run.json'), JSON.stringify({ directory }));
  return directory;
}

test('clearing simulation cache removes only simulation artifacts and is repeatable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-clean-sim-'));
  try {
    await previousRun(root);
    const preserved = ['top.v', 'project.xpr', '.vivado/project/project.xpr', '.vivado/reports/utilization.txt', '.vivado/build-state.json'];
    for (const file of preserved) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), file);
    }
    await clearSimulationCache(root);
    await assert.rejects(fs.access(path.join(root, '.vivado/sim')), { code: 'ENOENT' });
    for (const file of preserved) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), file);
    await clearSimulationCache(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('clearing simulation cache refuses redirected directories without deleting their contents', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-clean-redirect-'));
  try {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    const sentinel = path.join(outside, 'keep.txt');
    await fs.writeFile(sentinel, 'keep');
    for (const target of ['.vivado', '.vivado/sim']) {
      const root = path.join(base, target === '.vivado' ? 'parent-link' : 'cache-link');
      const link = path.join(root, target);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(clearSimulationCache(root), /real directory inside the project/);
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
      await fs.unlink(link);
    }
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('a failed simulation invalidates the previous result before compilation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-failed-sim-'));
  try {
    const oldDirectory = await previousRun(root);
    await fs.writeFile(path.join(root, 'tb.v'), 'module tb; endmodule');
    await writeConfig(root, validateConfig({ version: 1, name: 'example', part: 'xc7a35tcsg324-1', top: 'tb', sources: ['tb.v'] }));
    const missing = path.join(root, 'missing-tool.exe');
    const tools: Toolchain = { root, version: 'test', vivado: missing, xvlog: missing, xelab: missing, xsim: missing, glbl: missing };
    const project = await resolveProject(root);
    const options = { cwd: root, runTime: '1 us', timescale: '1ns/1ps' };
    await assert.rejects(simulate(tools, project, 'tb', { ...options, signal: AbortSignal.abort() }), CancelledError);
    assert.equal((await readSimulation(root)).directory, oldDirectory, 'An already-cancelled request never starts a new attempt.');
    await assert.rejects(simulate(tools, project, 'tb', options), /ENOENT/);
    await assert.rejects(readSimulation(root), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(oldDirectory, 'wave.vcd'), 'utf8'), 'old waveform');
    const attempts = await fs.readdir(path.join(root, '.vivado/sim'));
    assert.equal(attempts.filter(name => name.startsWith('run-')).length, 2);
    await clearSimulationCache(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
