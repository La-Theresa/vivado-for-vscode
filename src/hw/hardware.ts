import { TclSession } from '../toolchain/tclSession';
import { tclString } from '../project/sync';

export class NoHardwareError extends Error { constructor() { super('No hardware targets found. Connect and power the board, check the USB/JTAG driver, then retry.'); } }

export async function hardwareTargets(session: TclSession, serverUrl: string, signal?: AbortSignal): Promise<string[]> {
  const output = await session.execute(`
catch {close_hw}
open_hw
connect_hw_server -url ${tclString(serverUrl)}
join [get_hw_targets -quiet] "\n"
`, signal, 60000);
  const targets = output.split(/\r?\n/).filter(Boolean);
  if (!targets.length) throw new NoHardwareError();
  return targets;
}

export async function hardwareDevices(session: TclSession, target: string, signal?: AbortSignal): Promise<string[]> {
  return (await session.execute(`
set target [get_hw_targets -quiet ${tclString(target)}]
if {[llength $target] != 1} { error "Hardware target is no longer available." }
current_hw_target $target
open_hw_target
join [get_hw_devices -quiet] "\n"
`, signal, 60000)).split(/\r?\n/).filter(Boolean);
}

export async function programDevice(session: TclSession, device: string, bitstream: string, signal?: AbortSignal): Promise<void> {
  await session.execute(`
set device [get_hw_devices -quiet ${tclString(device)}]
if {[llength $device] != 1} { error "Selected hardware device is no longer available." }
current_hw_device $device
refresh_hw_device $device
set_property PROGRAM.FILE ${tclString(bitstream)} $device
program_hw_devices $device
`, signal, 120000);
}
