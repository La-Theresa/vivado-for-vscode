import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CircuitData, CircuitNode, CircuitPin } from '../views/previewModel';
import { tclString } from '../project/sync';

export function schematicTcl(filename: string): string {
  return `
proc vscode_xml {value} {
  return [string map {& &amp; < &lt; > &gt; \\" &quot; ' &apos;} $value]
}
proc vscode_net {object} {
  set nets [get_nets -quiet -segments -of_objects $object]
  if {[llength $nets] == 0} { return "" }
  return [lindex [lsort [get_property NAME $nets]] 0]
}
set schematic_file ${tclString(filename)}
set schematic [open "$schematic_file.tmp" w]
fconfigure $schematic -encoding utf-8
puts $schematic "<netlist top=\\"[vscode_xml [get_property NAME [current_design]]]\\" part=\\"[vscode_xml [get_property PART [current_design]]]\\" generatedAt=\\"[clock format [clock seconds] -format {%Y-%m-%d %H:%M:%S}]\\">"
set cell_count 0
foreach cell [get_cells -quiet -hierarchical -filter {IS_PRIMITIVE == 1}] {
  incr cell_count
  if {$cell_count > 1000} { break }
  puts $schematic "<cell name=\\"[vscode_xml [get_property NAME $cell]]\\" type=\\"[vscode_xml [get_property REF_NAME $cell]]\\">"
  foreach property {INIT IS_C_INVERTED IS_CLK_INVERTED IS_D_INVERTED IS_R_INVERTED IS_S_INVERTED} {
    if {[lsearch -exact [list_property $cell] $property] >= 0} {
      puts $schematic "<property name=\\"$property\\" value=\\"[vscode_xml [get_property $property $cell]]\\"/>"
    }
  }
  foreach pin [get_pins -quiet -of_objects $cell] {
    puts $schematic "<pin name=\\"[vscode_xml [get_property REF_PIN_NAME $pin]]\\" direction=\\"[get_property DIRECTION $pin]\\" net=\\"[vscode_xml [vscode_net $pin]]\\"/>"
  }
  puts $schematic "</cell>"
}
foreach port [get_ports -quiet] {
  puts $schematic "<port name=\\"[vscode_xml [get_property NAME $port]]\\" direction=\\"[get_property DIRECTION $port]\\" net=\\"[vscode_xml [vscode_net $port]]\\"/>"
}
puts $schematic "<count value=\\"$cell_count\\"/></netlist>"
close $schematic
file rename -force "$schematic_file.tmp" $schematic_file
`;
}

export function parseSchematic(xml: string, source: string): CircuitData {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid schematic export. Run synthesis again.');
  const data = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
    isArray: name => ['cell', 'pin', 'port', 'property'].includes(name),
  }).parse(xml).netlist;
  if (!data || typeof data.top !== 'string') throw new Error('Schematic export has no design.');
  if (Number(data.count?.value) > 1000 || (data.cell?.length || 0) > 1000 || (data.port?.length || 0) > 2000) {
    throw new Error('This netlist exceeds the preview limit (1000 cells / 2000 ports). Open it in Vivado GUI.');
  }
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid schematic property.');
    return value;
  };
  const direction = (value: unknown): CircuitPin['direction'] => {
    if (value !== 'IN' && value !== 'OUT' && value !== 'INOUT') throw new Error('Invalid pin direction.');
    return value;
  };
  const nodes: CircuitNode[] = [];
  for (const cell of data.cell || []) {
    const id = `c${nodes.length}`;
    nodes.push({ id, name: text(cell.name), type: text(cell.type), port: false,
      properties: Object.fromEntries((cell.property || []).map((property: Record<string, unknown>) => [text(property.name), text(property.value)])),
      pins: (cell.pin || []).map((pin: Record<string, unknown>, i: number) => ({
        id: `${id}p${i}`, name: text(pin.name), direction: direction(pin.direction), net: text(pin.net),
      })),
    });
  }
  for (const port of data.port || []) {
    const id = `c${nodes.length}`, dir = direction(port.direction);
    // A design input drives the circuit; a design output receives a value.
    nodes.push({ id, name: text(port.name), type: `${dir} PORT`, port: true, pins: [{
      id: `${id}p0`, name: text(port.name), direction: dir === 'IN' ? 'OUT' : dir === 'OUT' ? 'IN' : dir, net: text(port.net),
    }] });
  }
  if (nodes.reduce((sum, node) => sum + node.pins.length, 0) > 20000) throw new Error('Too many pins for the schematic preview. Use Vivado GUI.');
  return { kind: 'schematic', title: text(data.top), part: text(data.part), generatedAt: text(data.generatedAt), source, nodes };
}
