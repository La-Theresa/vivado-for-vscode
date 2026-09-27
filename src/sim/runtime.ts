export const DEFAULT_SIMULATION_RUN_TIME = '1 us';

export function normalizeSimulationRunTime(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Simulation duration must be all or a duration such as 1 us.');
  const text = value.trim();
  if (text === 'all') return text;
  const match = /^(\d+(?:\.\d+)?)\s*(s|ms|us|ns|ps|fs)$/.exec(text);
  if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) {
    throw new Error('Simulation duration must be all or a positive duration such as 1 us.');
  }
  return `${match[1]} ${match[2]}`;
}

export function simulationRunTime(project: { simulationRunTime?: string }, workspace?: string): string {
  return normalizeSimulationRunTime(project.simulationRunTime ?? workspace ?? DEFAULT_SIMULATION_RUN_TIME);
}
