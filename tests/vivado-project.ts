import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectToolchain } from '../src/toolchain/detect';
import { requireSuccess } from '../src/toolchain/process';
import { TclSession } from '../src/toolchain/tclSession';
import { resolveProject, writeConfig, validateConfig } from '../src/project/config';
import { syncProjectTcl, tclString } from '../src/project/sync';
import { importXpr } from '../src/project/importXpr';
import { runBatch } from '../src/build/builder';

async function main() {
  const tools = await detectToolchain(process.env.VIVADO_PATH);
  assert.ok(tools);
  const base = path.resolve('.test-work');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'project-'));
  await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: source => !source.includes('.vivado') });
  const project = await resolveProject(root);
  project.config.includeDirs = ['rtl', 'include dir'];
  project.config.defines = ['DEBUG', 'WIDTH=4'];
  await fs.mkdir(path.join(root, 'include dir'));
  await writeConfig(root, project.config);
  const resolved = await resolveProject(root);
  requireSuccess(await runBatch(tools, syncProjectTcl(resolved) + '\nclose_project', path.join(root, '.vivado/scripts/sync.tcl'), { cwd: root }), 'Project sync');
  const imported = importXpr(await fs.readFile(resolved.xpr, 'utf8'), resolved.xpr, root);
  assert.deepEqual(imported.config.includeDirs, ['rtl', 'include dir']);
  assert.deepEqual(imported.config.defines, ['DEBUG', 'WIDTH=4']);
  assert.equal(imported.config.simulationTop, 'tb');
  console.log('PASS real XPR round trip with multiple includes/defines and spaces');
  const session = new TclSession(tools.vivado, root);
  try {
    await session.execute(`open_project ${tclString(resolved.xpr)}`);
    const extra = path.join(root, 'rtl/extra.v');
    await fs.writeFile(extra, 'module extra; endmodule\n');
    resolved.files.sources.push(extra);
    await session.execute('close_project');
    await session.execute(syncProjectTcl(resolved));
    assert.equal(await session.execute('llength [get_files -of_objects [get_filesets sources_1]]'), '3');
    resolved.files.sources.pop();
    await session.execute('close_project');
    await session.execute(syncProjectTcl(resolved));
    assert.equal(await session.execute('llength [get_files -of_objects [get_filesets sources_1]]'), '2');
    await session.execute('close_project');
    console.log('PASS incremental add/remove synchronization');
    const completed = process.argv.find(arg => arg.startsWith('--completed='))?.slice(12);
    if (completed) {
      const completedRoot = path.resolve(completed);
      assert.ok(completedRoot.startsWith(base + path.sep));
      const built = await resolveProject(completedRoot);
      const source = built.files.sources[0];
      const original = await fs.readFile(source, 'utf8');
      await session.execute(`open_project ${tclString(built.xpr)}`);
      const before = await session.execute('get_property NEEDS_REFRESH [get_runs synth_1]');
      try {
        await fs.appendFile(source, '\n// external refresh probe\n');
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log(`NEEDS_REFRESH after external edit: ${before} -> ${await session.execute('get_property NEEDS_REFRESH [get_runs synth_1]')}`);
      } finally { await fs.writeFile(source, original); await session.execute('close_project'); }
    }
  } finally { await session.dispose(); }
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  const config = validateConfig({ version: 1, name: 'empty_project', part: project.config.part, top: 'top', sources: ['rtl/*.v'] });
  await writeConfig(empty, config);
  const emptyProject = await resolveProject(empty);
  requireSuccess(await runBatch(tools, syncProjectTcl(emptyProject) + '\nclose_project', path.join(empty, '.vivado/scripts/sync.tcl'), { cwd: empty }), 'New empty project');
  await fs.access(emptyProject.xpr);
  console.log(`PASS new empty project: ${root}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
