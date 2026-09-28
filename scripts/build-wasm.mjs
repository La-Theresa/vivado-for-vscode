import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, crate, target, sha256, readJson, readToml, sourceHashes, rustTools, lockedPackages } from './wasm-tools.mjs';

const artifact = path.join(root, 'dist/vivado_vcd_parser.wasm');
const receipt = path.join(root, 'dist/wasm-build.json');
const noticeFile = path.join(root, 'third_party/wasm-notices.json');

export async function checkedNotices() {
  const notices = await readJson(noticeFile);
  const lock = await fs.readFile(path.join(crate, 'Cargo.lock'));
  const toolchain = await readToml(path.join(crate, 'rust-toolchain.toml'));
  validateNotices(notices, toolchain.toolchain.channel, lock, lockedPackages(await readToml(path.join(crate, 'Cargo.lock'))));
  return notices;
}

export function validateNotices(notices, rustVersion, lock, application) {
  if (notices.format !== 1 || notices.rustVersion !== rustVersion
      || notices.applicationLockSha256 !== sha256(lock)
      || JSON.stringify(notices.application) !== JSON.stringify(application)
      || !/^[a-f0-9]{64}$/.test(notices.rustLibraryLockSha256) || !notices.runtime?.length) {
    throw new Error('WASM notices do not match the locked sources. Run npm run licenses:wasm and review the changes.');
  }
  for (const text of Object.entries(notices.texts)) {
    if (sha256(text[1]) !== text[0] || !text[1].trim()) throw new Error('WASM license text checksum mismatch.');
  }
  for (const entry of [...notices.application, ...notices.runtime]) {
    if (!notices.components.some(component => component.name === entry.name && component.version === entry.version
        && component.checksum === entry.checksum)) throw new Error(`Missing Rust notices: ${entry.name}@${entry.version}`);
  }
  if (!notices.components.some(component => component.name === 'Rust toolchain runtime' && component.version === notices.rustVersion)) {
    throw new Error('Rust toolchain runtime notices are missing.');
  }
  for (const component of notices.components) {
    if (!component.license || !component.licenses.length || component.licenses.some(license => !notices.texts[license.sha256])) {
      throw new Error(`Incomplete WASM notices: ${component.name}`);
    }
  }
}

export async function wasmNoticesMarkdown() {
  const notices = await checkedNotices();
  const result = [
    '\n# Self-built VCD WASM\n',
    '\nThe project-owned wrapper is MIT licensed. VCD parsing uses rust-vcd; no code from rust_vcd_wasm is bundled.\n',
    `\nRust ${notices.rustVersion}. ${notices.coverage}\n`,
  ];
  for (const component of notices.components) {
    result.push(`\n## ${component.name} ${component.version}\n\nLicense: ${component.license}\n\nSource: ${component.source}\n`);
    if (component.licenseSource) result.push(`\nSupplemental license source: ${component.licenseSource}\n`);
    for (const license of component.licenses) {
      result.push(`\n### ${license.file}\n\n\`\`\`text\n${notices.texts[license.sha256]}\n\`\`\`\n`);
    }
  }
  return result.join('');
}

function validateBinary(bytes) {
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('VCD WASM must not import host functions.');
  const parser = new WebAssembly.Instance(module).exports;
  if (parser.vcd_abi_version() !== 1) throw new Error('Unexpected VCD WASM ABI.');
  const input = Buffer.from('$timescale 1 ns $end\n$var wire 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n#5\n1!\n');
  const pointer = parser.vcd_alloc(input.length);
  new Uint8Array(parser.memory.buffer, pointer, input.length).set(input);
  const output = parser.vcd_parse(pointer, input.length);
  const length = new DataView(parser.memory.buffer).getUint32(output, true);
  const value = JSON.parse(Buffer.from(parser.memory.buffer, output + 4, length).toString('utf8'));
  parser.vcd_free(pointer, input.length);
  parser.vcd_free(output, length + 4);
  if (value.data?.endTime !== 5 || value.data.timelines[0][1][1] !== '1') throw new Error('VCD WASM functional smoke check failed.');
}

export async function verifyWasmArtifact() {
  await checkedNotices();
  const manifest = await readJson(receipt), sources = await sourceHashes();
  const bytes = await fs.readFile(artifact);
  if (manifest.format !== 1 || manifest.target !== target || manifest.abi !== 1
      || JSON.stringify(manifest.sources) !== JSON.stringify(sources) || manifest.wasmSha256 !== sha256(bytes)) {
    throw new Error('WASM artifact/provenance is missing, stale or modified. Rebuild with npm run build:wasm.');
  }
  validateBinary(bytes);
  return manifest;
}

export async function buildWasm({ force = false, verify = false } = {}) {
  if (!force && !verify) {
    const cached = await verifyWasmArtifact().catch(() => undefined);
    if (cached) return cached;
  }
  const notices = await checkedNotices();
  const tools = await rustTools();
  const stdLock = await fs.readFile(path.join(tools.sysroot, 'lib/rustlib/src/rust/library/Cargo.lock'));
  if (sha256(stdLock) !== notices.rustLibraryLockSha256
      || JSON.stringify(lockedPackages(await readToml(path.join(tools.sysroot, 'lib/rustlib/src/rust/library/Cargo.lock')))) !== JSON.stringify(notices.runtime)) {
    throw new Error('Rust standard-library notices do not match the installed pinned toolchain.');
  }
  const original = verify ? await verifyWasmArtifact() : undefined;
  let outputDir = path.join(crate, 'target');
  if (verify) {
    await fs.mkdir(path.join(root, '.test-work'), { recursive: true });
    outputDir = await fs.mkdtemp(path.join(root, '.test-work/wasm-repro-'));
  }
  const flags = [
    `--remap-path-prefix=${root}=/workspace`,
    `--remap-path-prefix=${tools.env.CARGO_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.cargo')}=/cargo`,
    `--remap-path-prefix=${tools.sysroot}=/rust`,
    '-C', 'link-arg=--max-memory=268435456',
  ];
  console.log(`Building VCD WASM with Rust ${tools.expected}, locked dependencies.`);
  await tools.run('cargo', ['build', '--locked', '--release', '--target', target, '--target-dir', outputDir], {
    CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
  });
  const bytes = await fs.readFile(path.join(outputDir, target, 'release/vivado_vcd_parser.wasm'));
  validateBinary(bytes);
  const hash = sha256(bytes);
  if (verify) {
    if (hash !== original.wasmSha256) throw new Error(`Clean WASM rebuild differs: ${hash} != ${original.wasmSha256}`);
    console.log(`PASS clean independent rebuild: SHA-256 ${hash}`);
    return original;
  }
  const manifest = {
    format: 1, abi: 1, target, rustVersion: tools.expected,
    rustCompiler: tools.version, wasmSha256: hash, bytes: bytes.length,
    command: ['cargo', 'build', '--locked', '--release', '--target', target],
    pathRemapping: true, maximumMemoryBytes: 268435456,
    sources: await sourceHashes(),
  };
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, bytes);
  await fs.writeFile(receipt, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built ${bytes.length} bytes; SHA-256 ${hash}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildWasm({ force: process.argv.includes('--force'), verify: process.argv.includes('--verify') });
}
