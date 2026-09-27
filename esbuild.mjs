import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const metadata = new Map();
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  metafile: true,
  minify: !process.argv.includes('--watch'),
  plugins: [{
    name: 'bundled-license-notices',
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length || !result.metafile) return;
        metadata.set(build.initialOptions.outfile, result.metafile);
        const packages = new Map();
        for (const input of [...metadata.values()].flatMap(meta => Object.keys(meta.inputs)).filter(file => file.includes('node_modules/'))) {
          let directory = path.dirname(path.resolve(input));
          while (directory.includes('node_modules')) {
            const metadata = await fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined);
            if (metadata?.name && metadata?.version) {
              packages.set(metadata.name, { directory, metadata });
              break;
            }
            directory = path.dirname(directory);
          }
        }
        const notices = ['# Bundled Dependency Notices\n\nThird-party components retain their own licenses; the extension MIT license does not replace them.\n'];
        const licenseAudit = [];
        for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
          const licenses = (await fs.readdir(directory)).filter(file => /^(license|licence|copying)(\.|$)/i.test(file));
          const supplemental = name === '@nodable/entities' && metadata.version === '3.0.0'
            ? 'third_party/nodable-entities-LICENSE.txt' : undefined;
          const source = name === 'elkjs'
            ? `https://github.com/kieler/elkjs/tree/${metadata.version}`
            : name === 'rust_vcd_wasm' && metadata.version === '0.1.6'
              ? 'https://github.com/msBRF65/rust_vcd_wasm/tree/1b568d01e823f6ca1e7e11f213f86110ad0f638c'
              : undefined;
          notices.push(`\n## ${name} ${metadata.version}\n\nLicense: ${metadata.license || 'See notice below'}\n`);
          if (source) notices.push(`\nUpstream source: ${source}\n`);
          if (name === 'elkjs') notices.push('\nDistributed under EPL-2.0. Corresponding source is available from the upstream link under that license. No local source modifications; bundled and minified by esbuild.\n');
          for (const license of licenses) notices.push('\n```text\n' + await fs.readFile(path.join(directory, license), 'utf8') + '\n```\n');
          if (!licenses.length && supplemental) notices.push('\n```text\n' + await fs.readFile(supplemental, 'utf8') + '\n```\n');
          const missingLicenseText = !licenses.length && !supplemental;
          if (missingLicenseText) notices.push('\nRELEASE BLOCKER: License text is missing from the installed package. Verify upstream notices before redistribution.\n');
          licenseAudit.push({ name, version: metadata.version, license: metadata.license, missingLicenseText });
        }
        await fs.mkdir('dist', { recursive: true });
        await fs.writeFile('dist/THIRD_PARTY_NOTICES.md', notices.join(''), 'utf8');
        await fs.writeFile('dist/license-audit.json', JSON.stringify(licenseAudit, null, 2) + '\n', 'utf8');
      });
    },
  }],
  logLevel: 'info',
});
const preview = await esbuild.context({
  entryPoints: ['src/webview/preview.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'chrome120',
  outfile: 'dist/preview.js', sourcemap: true, minify: !process.argv.includes('--watch'), metafile: true,
  plugins: [{
    name: 'preview-license-notices',
    setup(build) {
      build.onEnd(async result => {
        if (result.metafile) {
          metadata.set(build.initialOptions.outfile, result.metafile);
          await ctx.rebuild();
        }
      });
    },
  }],
  logLevel: 'info',
});
await fs.mkdir('dist', { recursive: true });
await fs.copyFile('node_modules/rust_vcd_wasm/rust_vcd_wasm_bg.wasm', 'dist/rust_vcd_wasm_bg.wasm');
if (process.argv.includes('--watch')) {
  await ctx.watch();
  await preview.watch();
} else {
  await preview.rebuild();
  await preview.dispose();
  await ctx.dispose();
}
