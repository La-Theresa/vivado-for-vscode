import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

async function main() {
  await fs.mkdir(path.resolve('.test-work'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-work/extension-project-'));
  await fs.cp(path.resolve('examples/counter'), root, { recursive: true, filter: source => !source.includes('.vivado') });
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(root, '.vscode/settings.json'), JSON.stringify({
    'vivado.installPath': process.env.VIVADO_PATH || 'D:/vivado/Vivado/2018.3',
    'vivado.lint.debounceMs': 150,
    'vivado.lint.elaborate': 'onIdle',
  }));
  const tests = path.resolve('.test-work/extension-tests.cjs');
  await build({ entryPoints: ['tests/extension-host.ts'], outfile: tests, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: true });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || (process.platform === 'win32' ? 'D:/Microsoft VS Code/Code.exe' : undefined),
    extensionDevelopmentPath: path.resolve('.'), extensionTestsPath: tests,
    launchArgs: [root, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', path.resolve('.test-work/vscode-user'), '--extensions-dir', path.resolve('.test-work/vscode-extensions')],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
