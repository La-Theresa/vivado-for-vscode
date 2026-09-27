import { IoAssignment, IoData, IoPort } from '../views/previewModel';

export interface IoValidation { assignments: IoAssignment[]; errors: string[]; warnings: string[] }

export function validateIoAssignments(data: IoData, value: unknown): IoValidation {
  const errors: string[] = [], warnings: string[] = [], assignments: IoAssignment[] = [];
  if (!Array.isArray(value) || value.length !== data.ports.length) return { assignments, errors: ['The port list changed. Reload I/O Planning.'], warnings };
  const ports = new Map(data.ports.map(port => [port.name, port]));
  const pins = new Map(data.pins.map(pin => [pin.name, pin]));
  const standards = new Map(data.standards.map(standard => [standard.name, standard]));
  const banks = new Map(data.banks.map(bank => [bank.name, bank]));
  const seen = new Set<string>(), occupied = new Map<string, string>(), voltages = new Map<string, Set<number>>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.packagePin !== 'string' || typeof entry.ioStandard !== 'string') {
      errors.push('Invalid I/O assignment.'); continue;
    }
    const port: IoPort | undefined = ports.get(entry.name);
    if (!port || seen.has(entry.name)) { errors.push(`Unknown or repeated port: ${String(entry.name).slice(0, 100)}`); continue; }
    seen.add(entry.name);
    const assignment = { name: port.name, packagePin: entry.packagePin.trim().toUpperCase(), ioStandard: entry.ioStandard.trim().toUpperCase() };
    if (assignment.ioStandard === 'DEFAULT') assignment.ioStandard = '';
    assignments.push(assignment);
    const pin = pins.get(assignment.packagePin), standard = standards.get(assignment.ioStandard);
    if (assignment.packagePin && !pin) errors.push(`${port.name}: ${assignment.packagePin} is not a bonded general-purpose I/O pin on ${data.part}.`);
    if (assignment.packagePin) {
      const other = occupied.get(assignment.packagePin);
      if (other) errors.push(`${assignment.packagePin} is assigned to both ${other} and ${port.name}.`);
      occupied.set(assignment.packagePin, port.name);
    }
    if (assignment.ioStandard && !standard) errors.push(`${port.name}: unknown I/O standard ${assignment.ioStandard}.`);
    if (standard) {
      const direction = { IN: 'INPUT', OUT: 'OUTPUT', INOUT: 'BIDIR' }[port.direction];
      if (!standard.directions.includes(direction)) errors.push(`${port.name}: ${standard.name} does not support ${port.direction}.`);
      if (pin && !banks.get(pin.bank)?.standards.includes(standard.name)) errors.push(`${port.name}: ${standard.name} is not supported in bank ${pin.bank}.`);
      if (pin) {
        const required = voltages.get(pin.bank) || new Set<number>();
        const voltage = port.direction === 'IN' ? standard.vccoIn : standard.vccoOut;
        if (voltage > 0) required.add(voltage);
        voltages.set(pin.bank, required);
      }
    }
  }
  const incomplete = assignments.filter(port => !port.packagePin || !port.ioStandard).length;
  if (incomplete) warnings.push(`${incomplete} port(s) have no package pin or I/O standard.`);
  for (const [bank, values] of voltages) if (values.size > 1) warnings.push(`Bank ${bank} has mixed nominal VCCO requirements (${[...values].join(', ')} V). Board voltage and Vivado DRC must be checked.`);
  return { assignments, errors, warnings };
}
