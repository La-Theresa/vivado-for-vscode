import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

async function main() {
  await fs.mkdir(path.resolve('.test-work'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-work/extension-project-'));
  await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: source => !source.includes('.vivado') });
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(root, '.vscode/settings.json'), JSON.stringify({
    'vivado.installPath': process.env.VIVADO_PATH || '',
    'vivado.lint.debounceMs': 150,
    'vivado.lint.elaborate': 'onIdle',
    'verilog.linting.linter': 'none',
  }));
  const extensions = path.resolve('.test-work/vscode-extensions');
  await fs.mkdir(extensions, { recursive: true });
  const installed = process.env.VSCODE_EXTENSIONS || path.join(os.homedir(), '.vscode', 'extensions');
  const dependencies: string[] = [];
  for (const dependency of ['mshr-h.veriloghdl']) {
    const candidates = (await fs.readdir(installed)).filter(name => name.startsWith(dependency + '-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!candidates.length) throw new Error(`Install ${dependency} before testing, or set VSCODE_EXTENSIONS to an extension directory containing it.`);
    dependencies.push(path.join(installed, candidates[0]));
  }
  const tests = path.resolve('.test-work/extension-tests.cjs');
  await build({ entryPoints: ['tests/extension-host.ts'], outfile: tests, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: true });
  const extensionRoot = path.resolve(process.env.VIVADO_EXTENSION_PATH || '.');
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  console.log(`Testing extension from ${extensionRoot}`);
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    extensionDevelopmentPath: [extensionRoot, ...dependencies], extensionTestsPath: tests,
    extensionTestsEnv: { VIVADO_EXTENSION_ID: `${manifest.publisher}.${manifest.name}` },
    launchArgs: [root, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', path.resolve('.test-work/vscode-user'), '--extensions-dir', path.resolve('.test-work/vscode-extensions')],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
