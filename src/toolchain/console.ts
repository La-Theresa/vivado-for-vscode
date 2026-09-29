import { portablePath, ResolvedProject } from '../project/config';
import { tclString } from '../project/sync';
import { HardwareConnection, restoreHardwareTcl } from '../hw/hardware';
import { windowsBatchCommand } from './process';

export function consoleStartupTcl(project: ResolvedProject, hardware?: HardwareConnection): string {
  return `if {[catch {open_project ${tclString(project.xpr)}} console_error]} {
  puts stderr "Could not open project: $console_error"
}
${hardware ? `if {[catch {
${restoreHardwareTcl(hardware)}} console_error]} {
  puts stderr "Could not restore hardware connection: $console_error"
}
` : ''}`;
}

export function consoleShell(executable: string, script: string, platform = process.platform): { shellPath: string; shellArgs: string | string[] } {
  const args = ['-mode', 'tcl', '-nolog', '-nojournal', '-source', portablePath(script)];
  return platform === 'win32'
    ? { shellPath: process.env.ComSpec || 'cmd.exe', shellArgs: `/d /s /v:off /c ${windowsBatchCommand(executable, args)}` }
    : { shellPath: executable, shellArgs: args };
}
