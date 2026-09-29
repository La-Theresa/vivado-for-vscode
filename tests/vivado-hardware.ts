import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBatch } from '../src/build/builder';
import { readHardwareConnection } from '../src/hw/hardware';
import { createProjectFolder } from '../src/project/create';
import { resolveProject } from '../src/project/config';
import { syncProjectTcl, tclString } from '../src/project/sync';
import { consoleStartupTcl } from '../src/toolchain/console';
import { detectToolchain } from '../src/toolchain/detect';
import { requireSuccess } from '../src/toolchain/process';
import { TclSession } from '../src/toolchain/tclSession';

async function main() {
  const tools = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tools, 'Vivado installation not found. Set VIVADO_PATH.');
  const base = path.resolve('.test-work');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'hardware-console-'));
  const root = await createProjectFolder(directory, 'console_hardware', 'xc7a35tcsg324-1', 'top');
  const project = await resolveProject(root);
  requireSuccess(await runBatch(tools, syncProjectTcl(project) + '\nclose_project',
    path.join(root, '.vivado/scripts/sync.tcl'), { cwd: root }), 'Console project creation');
  const background = new TclSession(tools.vivado, root);
  const consoleSession = new TclSession(tools.vivado, root);
  try {
    assert.equal(await readHardwareConnection(background), undefined);
    await background.execute(`open_hw\nconnect_hw_server -url ${tclString(process.env.HW_SERVER_URL || 'localhost:3121')}`, undefined, 60000);
    const connection = await readHardwareConnection(background);
    assert.ok(connection);
    assert.equal(connection.target, undefined, 'Server-only checks must not open a physical hardware target.');
    const startup = consoleStartupTcl(project, connection);
    await background.execute('close_hw', undefined, 60000);
    assert.equal(await readHardwareConnection(background), undefined);
    await consoleSession.execute(startup, undefined, 60000);
    assert.equal(await consoleSession.execute('get_property NAME [current_project]'), project.config.name);
    assert.deepEqual(await readHardwareConnection(consoleSession), connection);
    await consoleSession.execute('disconnect_hw_server');
    assert.equal(await readHardwareConnection(consoleSession), undefined);
    assert.equal(await readHardwareConnection(background), undefined);
    console.log('PASS real Vivado: background connection handed off; disconnect_hw_server releases the console connection');

    await consoleSession.execute('close_project');
    await consoleSession.execute(consoleStartupTcl(project));
    assert.equal(await readHardwareConnection(consoleSession), undefined, 'Reopening without a connection must not reconnect stale state.');
    await consoleSession.execute('close_project');
    await consoleSession.execute(consoleStartupTcl(project, { ...connection, target: '__missing_hardware_target__' }), undefined, 60000);
    assert.ok(await readHardwareConnection(consoleSession), 'A missing target must leave the server accessible for manual recovery.');
    await consoleSession.execute('disconnect_hw_server\nclose_hw\nclose_project', undefined, 60000);
    console.log('PASS real Vivado: no stale reconnection; missing-target errors leave Tcl usable');

    // Stub only hardware commands to cover target/device handoff without touching a board.
    const target = 'host:4567/xilinx_tcf/board [1] {$id} "\u4e2d\u6587"';
    const device = 'fpga[0] "selected"';
    await consoleSession.execute(`
foreach command {open_hw close_hw connect_hw_server current_hw_server current_hw_target current_hw_device get_hw_targets get_hw_devices get_property open_hw_target} {
  rename $command native_$command
}
set test_target ${tclString(target)}
set test_device ${tclString(device)}
set test_server host:4567
set test_open 1
set test_current_device $test_device
set test_available_targets [list wrong_target $test_target]
set test_available_devices [list wrong_device $test_device]
proc open_hw {} {}
proc close_hw {} { set ::test_server ""; set ::test_open 0 }
proc connect_hw_server {flag url} { set ::test_server $url }
proc current_hw_server {args} { return $::test_server }
proc current_hw_target {args} {
  if {[llength $args] && [lindex $args 0] ne "-quiet" && [lindex $args 0] ne $::test_target} { error "Wrong target" }
  return $::test_target
}
proc current_hw_device {args} {
  if {[llength $args] && [lindex $args 0] ne "-quiet"} { set ::test_current_device [lindex $args 0] }
  return $::test_current_device
}
proc get_hw_targets {args} { return $::test_available_targets }
proc get_hw_devices {args} { return $::test_available_devices }
proc get_property {property object} {
  switch -- $property {
    HOST { return host }
    PORT { return 4567 }
    IS_OPENED { return $::test_open }
    default { error "Unexpected property: $property" }
  }
}
proc open_hw_target {} {
  if {$::test_open} { error "Background target still open" }
  set ::test_open 1
  set ::test_current_device wrong_device
}
`);
    const selected = await readHardwareConnection(consoleSession);
    assert.deepEqual(selected, { serverUrl: 'host:4567', target, device });
    await consoleSession.execute('close_hw');
    assert.equal(await readHardwareConnection(consoleSession), undefined);
    await consoleSession.execute(consoleStartupTcl(project, selected));
    assert.deepEqual(await readHardwareConnection(consoleSession), selected);
    await consoleSession.execute('set test_open 0');
    assert.deepEqual(await readHardwareConnection(consoleSession),
      { serverUrl: 'host:4567', target: undefined, device: undefined });
    await consoleSession.execute('close_project\nclose_hw\nset test_available_devices {}');
    await consoleSession.execute(consoleStartupTcl(project, selected));
    assert.match(await consoleSession.execute('set console_error'), /hardware device is no longer available/);
    await consoleSession.execute('close_project\nclose_hw\nproc connect_hw_server {args} { error "Server offline" }');
    await consoleSession.execute(consoleStartupTcl(project, selected));
    assert.equal(await consoleSession.execute('set console_error'), 'Server offline');
    assert.equal(await readHardwareConnection(consoleSession), undefined);
    console.log('PASS Tcl regression: exact target/device selection, closed target, missing device and offline server');
  } finally {
    await consoleSession.dispose();
    await background.dispose();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
