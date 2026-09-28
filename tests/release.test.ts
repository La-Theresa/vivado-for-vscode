import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFiles, PackageManager } from '@vscode/vsce';

const localNotes = ['LOCAL_DEVELOPMENT.md', 'TESTING.md', 'PUBLISHING.md', 'RELEASE_REVIEW.md'];

test('VSIX allowlist includes runtime assets but excludes credentials and arbitrary local files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vivado-release-'));
  const included = [
    'package.json', 'README.md', 'README.zh-CN.md', 'LICENSE',
    'dist/extension.js', 'dist/preview.js', 'dist/preview.css',
    'dist/vivado_vcd_parser.wasm', 'dist/wasm-build.json', 'dist/THIRD_PARTY_NOTICES.md',
    'resources/vivado.svg', 'resources/project.schema.json',
  ];
  const excluded = [
    '.env', '.env.production', '.npmrc', '.vsce', 'private.pem',
    '.vscode/settings.json', '.codex/session.json', '.agents/local.md',
    '.test-work/profile/Preferences', 'node_modules/example/index.js',
    'examples/counter/rtl/top.v', '.vivado/project/top.bit',
    'dist/extension.js.map', 'dist/unexpected.js', 'dist/.env',
    'dist/license-audit.json', 'resources/private.key',
    'dist/rust_vcd_wasm_bg.wasm', '.tools/rustup/settings.toml', 'wasm/vcd-parser/target/debug/parser.exe',
    'src/extension.ts', 'tests/local.ts', 'scripts/local.mjs',
    ...localNotes, 'local-notes.txt', 'old.vsix',
  ];
  try {
    await fs.copyFile('.vscodeignore', path.join(root, '.vscodeignore'));
    for (const file of [...included, ...excluded]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), file === 'package.json' ? JSON.stringify({
        name: 'release-fixture', version: '0.0.1', publisher: 'fixture',
        engines: { vscode: '^1.90.0' }, main: './dist/extension.js', activationEvents: [],
      }) : 'Harmless packaging fixture\n');
    }
    const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
    assert.deepEqual(files.map(file => file.replace(/\\/g, '/')).sort(), included.sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git ignores local credentials, maintainer notes and generated artifacts', () => {
  const files = [
    '.env', '.env.local', '.npmrc', '.vsce', 'private.pem', 'credentials.key',
    'certificate.pfx', '.vscode/settings.json', '.codex/session.json',
    '.test-work/profile/Preferences', 'examples/counter/.vivado/project/top.bit',
    'node_modules/example/index.js', 'dist/extension.js', 'old.vsix',
    'vivado.log', 'simulation.vcd', 'simulation.wdb',
    '.tools/cargo/bin/cargo.exe', 'wasm/vcd-parser/target/release/parser.exe',
    ...localNotes,
  ];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    encoding: 'utf8', input: files.join('\n') + '\n',
  }).trim().split(/\r?\n/);
  assert.deepEqual(ignored.sort(), files.sort());
  const shared = ['README.md', 'README.zh-CN.md', 'LICENSE', 'third_party/README.md',
    'third_party/nodable-entities-LICENSE.txt', 'tests/core.test.ts', 'tests/run-extension.ts',
    'scripts/check-release.mjs', 'resources/tcl/README.md', '.vscode/launch.json',
    'wasm/vcd-parser/Cargo.lock', 'wasm/vcd-parser/src/lib.rs', 'third_party/wasm-notices.json', '.gitattributes'];
  const matches = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    encoding: 'utf8', input: [...files, ...shared].join('\n') + '\n',
  }).trim().split(/\r?\n/);
  assert.deepEqual(matches.sort(), files.sort(), 'Shared project files must not be ignored');
  const trackedNotes = execFileSync('git', ['ls-files', '--', ...localNotes], { encoding: 'utf8' }).trim();
  assert.equal(trackedNotes, '', 'Local maintainer notes must not remain in the Git index');
});

test('README languages cross-link and document all contributed settings with the same project example', async () => {
  const english = await fs.readFile('README.md', 'utf8');
  const chinese = await fs.readFile('README.zh-CN.md', 'utf8');
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(english.includes('(README.zh-CN.md)'));
  assert.ok(chinese.includes('(README.md)'));
  const example = (text: string) => JSON.parse(text.match(/```json\r?\n([\s\S]*?)```/)![1]);
  assert.deepEqual(example(english), example(chinese));
  for (const setting of Object.keys(manifest.contributes.configuration.properties)) {
    for (const text of [english, chinese]) assert.ok(text.includes(`\`${setting}\``), `Undocumented setting: ${setting}`);
  }
  for (const text of [english, chinese]) {
    assert.ok(text.includes('(third_party/README.md)'));
  }
});

test('Public README links resolve without local maintainer notes', async () => {
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const text = await fs.readFile(file, 'utf8');
    for (const note of localNotes) assert.ok(!text.includes(note), `${file} references local-only ${note}`);
    assert.ok(!text.includes('.test-work/'), `${file} contains local test output references`);
    assert.doesNotMatch(text, /npm run (?:test:(?:vivado|extension|preview|io)|check:release)/);
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const relative = decodeURIComponent(target.split('#')[0]);
      await fs.access(path.resolve(path.dirname(file), relative));
    }
  }
});
