export interface WaveSignal {
  name: string;
  width: number;
  type: string;
  changes: [number, string][];
}

export interface WaveData {
  kind: 'waveform';
  title: string;
  source: string;
  timescale: number;
  unit: string;
  endTime: number;
  signals: WaveSignal[];
}

export interface CircuitPin { id: string; name: string; direction: 'IN' | 'OUT' | 'INOUT'; net: string }
export interface CircuitNode { id: string; name: string; type: string; pins: CircuitPin[]; port: boolean; properties?: Record<string, string> }
export interface CircuitData {
  kind: 'schematic';
  title: string;
  source: string;
  part: string;
  generatedAt: string;
  stale?: boolean;
  nodes: CircuitNode[];
}
export interface IoPin { name: string; bank: string; function: string; clock: boolean; differentialMate: string }
export interface IoBank { name: string; type: string; standards: string[] }
export interface IoStandard { name: string; directions: string[]; vccoIn: number; vccoOut: number }
export interface IoAssignment { name: string; packagePin: string; ioStandard: string }
export interface IoPort extends IoAssignment { direction: 'IN' | 'OUT' | 'INOUT' }
export interface IoData {
  kind: 'ioPlanning';
  title: string;
  source: string;
  part: string;
  generatedAt: string;
  revision: string;
  ports: IoPort[];
  pins: IoPin[];
  banks: IoBank[];
  standards: IoStandard[];
  constraintFile: string;
  selectedPort?: string;
  stale?: string;
}
export type PreviewData = WaveData | CircuitData | IoData;
