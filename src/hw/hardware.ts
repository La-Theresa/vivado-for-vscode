import { TclSession } from '../toolchain/tclSession';
import { tclString } from '../project/sync';

export class NoHardwareError extends Error { constructor() { super('No hardware targets found. Connect and power the board, check the USB/JTAG driver, then retry.'); } }

export interface HardwareConnection {
  serverUrl: string;
  target?: string;
  device?: string;
}

export async function readHardwareConnection(session: TclSession, signal?: AbortSignal): Promise<HardwareConnection | undefined> {
  const output = await session.execute(`
set console_connection {}
set console_server [current_hw_server -quiet]
if {$console_server ne ""} {
  set console_url "[get_property HOST $console_server]:[get_property PORT $console_server]"
  set console_target [current_hw_target -quiet]
  set console_device ""
  if {$console_target ne "" && [get_property IS_OPENED $console_target]} {
    set console_device [current_hw_device -quiet]
  } else {
    set console_target ""
  }
  foreach value [list $console_url $console_target $console_device] {
    binary scan [encoding convertto utf-8 $value] H* console_hex
    lappend console_connection $console_hex
  }
}
join $console_connection "\\n"
`, signal);
  if (!output) return undefined;
  // Hex fields preserve Tcl names containing whitespace, braces or substitutions.
  const [serverUrl, target, device] = output.split(/\r?\n/).map(value => Buffer.from(value, 'hex').toString('utf8'));
  return { serverUrl, target: target || undefined, device: device || undefined };
}

export function restoreHardwareTcl(connection: HardwareConnection): string {
  return `open_hw
connect_hw_server -url ${tclString(connection.serverUrl)}
${connection.target ? `set console_target [lsearch -inline -exact [get_hw_targets -quiet -of_objects [current_hw_server]] ${tclString(connection.target)}]
if {$console_target eq ""} { error "Previously connected hardware target is no longer available." }
current_hw_target $console_target
open_hw_target
${connection.device ? `set console_device [lsearch -inline -exact [get_hw_devices -quiet -of_objects [current_hw_target]] ${tclString(connection.device)}]
if {$console_device eq ""} { error "Previously selected hardware device is no longer available." }
current_hw_device $console_device
` : ''}` : ''}`;
}

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
