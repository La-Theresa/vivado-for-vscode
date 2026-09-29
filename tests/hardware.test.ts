import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readHardwareConnection, restoreHardwareTcl } from '../src/hw/hardware';
import { resolveProject } from '../src/project/config';
import { tclString } from '../src/project/sync';
import { consoleStartupTcl } from '../src/toolchain/console';
import { TclSession } from '../src/toolchain/tclSession';

const encodeConnection = (...fields: string[]) => fields.map(value => Buffer.from(value, 'utf8').toString('hex')).join('\n');

test('hardware snapshot reads the live session without reconnecting or releasing it', async () => {
  const signal = new AbortController().signal;
  const connection = {
    serverUrl: 'remote-host:4567',
    target: 'remote-host:4567/xilinx_tcf/Digilent/board [1] {$id} "\u4e2d\u6587"',
    device: 'xc7a35t_0',
  };
  const session = { execute: async (script: string, receivedSignal?: AbortSignal) => {
    assert.equal(receivedSignal, signal);
    assert.match(script, /current_hw_server -quiet/);
    assert.match(script, /get_property HOST/);
    assert.match(script, /get_property PORT/);
    assert.match(script, /get_property IS_OPENED/);
    assert.match(script, /current_hw_device -quiet/);
    assert.doesNotMatch(script, /\b(?:open_hw|close_hw|connect_hw_server|disconnect_hw_server|program_hw_devices)\b/);
    return encodeConnection(connection.serverUrl, connection.target, connection.device);
  } } as TclSession;
  assert.deepEqual(await readHardwareConnection(session, signal), connection);
});

test('hardware snapshots distinguish no connection from a server without an open target', async () => {
  const session = (output: string) => ({ execute: async () => output }) as unknown as TclSession;
  assert.equal(await readHardwareConnection(session('')), undefined);
  assert.deepEqual(await readHardwareConnection(session(encodeConnection('localhost:3121', '', ''))),
    { serverUrl: 'localhost:3121', target: undefined, device: undefined });
  assert.deepEqual(await readHardwareConnection(session(encodeConnection('localhost:3121', 'target', ''))),
    { serverUrl: 'localhost:3121', target: 'target', device: undefined });
});

test('hardware snapshot failures propagate instead of silently dropping the connection', async () => {
  const error = new Error('Session closed');
  const session = { execute: async () => { throw error; } } as unknown as TclSession;
  await assert.rejects(readHardwareConnection(session), error);
});

test('hardware restoration preserves exact target/device names and never programs or forces a target', () => {
  const connection = { serverUrl: 'host:4567', target: 'host:4567/board [1] {$id}', device: 'fpga[0] "name"' };
  const script = restoreHardwareTcl(connection);
  assert.match(script, /^open_hw\nconnect_hw_server/);
  for (const value of Object.values(connection)) assert.ok(script.includes(tclString(value)));
  assert.match(script, /lsearch -inline -exact \[get_hw_targets -quiet -of_objects \[current_hw_server\]\]/);
  assert.match(script, /lsearch -inline -exact \[get_hw_devices -quiet -of_objects \[current_hw_target\]\]/);
  assert.ok(script.indexOf('current_hw_target $console_target') < script.indexOf('open_hw_target'));
  assert.ok(script.indexOf('open_hw_target') < script.indexOf('current_hw_device $console_device'));
  assert.match(script, /hardware target is no longer available/);
  assert.match(script, /hardware device is no longer available/);
  assert.doesNotMatch(script, /program_hw_devices|PROGRAM\.FILE|-force|lindex/);
  assert.equal(restoreHardwareTcl({ serverUrl: 'localhost:3121' }), 'open_hw\nconnect_hw_server -url "localhost:3121"\n');
});

test('console startup restores hardware independently of project loading and remains interactive on errors', async () => {
  const project = await resolveProject(path.resolve('examples/counter'));
  const script = consoleStartupTcl(project, { serverUrl: 'localhost:3121' });
  assert.match(script, /if \{\[catch \{open_project/);
  assert.match(script, /if \{\[catch \{\nopen_hw\nconnect_hw_server/);
  assert.match(script, /puts stderr "Could not restore hardware connection: \$console_error"/);
  assert.doesNotMatch(script, /\bexit\b|@@BEGIN|@@END/);
});
