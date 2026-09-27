import fs from 'node:fs/promises';
import { listFiles, PackageManager } from '@vscode/vsce';

const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
const licenses = JSON.parse(await fs.readFile('dist/license-audit.json', 'utf8'));
const errors = [];

if (manifest.publisher === 'local-vivado' || !manifest.publisher) {
  errors.push('Replace the local-vivado placeholder with a Marketplace publisher ID you control.');
}
if (!manifest.repository?.url || !manifest.homepage || !manifest.bugs?.url) {
  errors.push('Set repository, homepage and bugs URLs before publishing.');
}
for (const dependency of licenses) {
  if (dependency.missingLicenseText) {
    errors.push(`Missing license text: ${dependency.name}@${dependency.version}. See third_party/README.md.`);
  }
}

const expected = new Set([
  'package.json', 'README.md', 'README.zh-CN.md', 'LICENSE',
  'dist/extension.js', 'dist/preview.js', 'dist/preview.css',
  'dist/rust_vcd_wasm_bg.wasm', 'dist/THIRD_PARTY_NOTICES.md',
  'resources/vivado.svg', 'resources/project.schema.json',
]);
const files = await listFiles({ cwd: process.cwd(), packageManager: PackageManager.None });
for (const file of files) {
  const normalized = file.replace(/\\/g, '/');
  if (!expected.delete(normalized)) errors.push(`Unexpected VSIX file: ${file}`);
}
for (const file of expected) errors.push(`Missing VSIX file: ${file}`);

if (errors.length) {
  console.error('Release preflight failed:\n' + errors.map(error => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Release file and notice checks passed. Confirm publisher ownership, credentials, Git history and hardware limitations manually.');
}
