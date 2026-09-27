import ELK, { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { CircuitData, CircuitNode, CircuitPin } from './previewModel';
import { logicSymbol } from './logicSymbols';

export interface CircuitLayout { graph: ElkNode; edgeNets: Map<string, string> }

export async function layoutCircuit(data: CircuitData): Promise<CircuitLayout> {
  const nets = new Map<string, { node: CircuitNode; pin: CircuitPin }[]>();
  const children: ElkNode[] = data.nodes.map(node => {
    const symbol = logicSymbol(node);
    const bottom = (pin: CircuitPin) => symbol.kind === 'mux' && pin.name === 'S';
    const inputs = node.pins.filter(pin => pin.direction === 'IN' && !bottom(pin)).length;
    const outputs = node.pins.filter(pin => pin.direction !== 'IN').length;
    for (const pin of node.pins) {
      if (!pin.net) continue;
      const connections = nets.get(pin.net) || [];
      connections.push({ node, pin });
      nets.set(pin.net, connections);
    }
    const width = node.port ? 150 : Math.max(180, Math.min(270, node.name.length * 7 + 24));
    const height = node.port ? 52 : Math.max(110, 62 + Math.max(inputs, outputs, 1) * 24);
    let left = 0, right = 0;
    return {
      id: node.id,
      width,
      height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: node.pins.map(pin => ({
        id: pin.id, width: 6, height: 6,
        x: bottom(pin) ? width / 2 - 3 : pin.direction === 'IN' ? -3 : width - 3,
        y: bottom(pin) ? height - 3 : node.port ? 23 : 29 + (height - 56) * ((pin.direction === 'IN' ? ++left : ++right) / ((pin.direction === 'IN' ? inputs : outputs) + 1)),
        layoutOptions: { 'elk.port.side': bottom(pin) ? 'SOUTH' : pin.direction === 'IN' ? 'WEST' : 'EAST' },
      })),
    };
  });
  const edges: NonNullable<ElkNode['edges']> = [], edgeNets = new Map<string, string>();
  for (const [net, endpoints] of nets) {
    const drivers = endpoints.filter(({ pin }) => pin.direction !== 'IN');
    const sinks = endpoints.filter(({ pin }) => pin.direction !== 'OUT');
    for (const driver of drivers) for (const sink of sinks) {
      if (driver.pin.id === sink.pin.id) continue;
      if (edges.length >= 6000) throw new Error('More than 6000 connections. Open this netlist in Vivado GUI.');
      const id = `e${edges.length}`;
      edges.push({ id, sources: [driver.pin.id], targets: [sink.pin.id] });
      edgeNets.set(id, net);
    }
  }
  const elk = new ELK();
  const graph = await elk.layout({
      id: 'root', children, edges,
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.padding': '[top=30,left=30,bottom=30,right=30]',
      },
  });
  return { graph, edgeNets };
}
