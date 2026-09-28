import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { root, crate, sha256, readToml, rustTools, lockedPackages } from './wasm-tools.mjs';

const exec = promisify(execFile);
const tools = await rustTools();
const stdRoot = path.join(tools.sysroot, 'lib/rustlib/src/rust/library');
const lock = await fs.readFile(path.join(crate, 'Cargo.lock'));
const stdLock = await fs.readFile(path.join(stdRoot, 'Cargo.lock'));
const application = lockedPackages(await readToml(path.join(crate, 'Cargo.lock')));
const runtime = lockedPackages(await readToml(path.join(stdRoot, 'Cargo.lock')));
const packages = new Map([...application, ...runtime].map(item => [`${item.name}@${item.version}`, item]));
const texts = {}, components = [];
const cache = path.join(root, '.tools/wasm-license-sources');
await fs.mkdir(cache, { recursive: true });

// This non-WASM platform crate omits its license file in the registry archive.
// Pin the source commit recorded in that archive, and the upstream Git blob.
const supplemental = {
  'fortanix-sgx-abi-0.5.0': {
    repository: 'fortanix/rust-sgx',
    commit: '4bbac9583f3635026b35e8c17001b20973296301',
    file: 'LICENSE',
    blob: '14e2f777f6c395e7e04ab4aa306bbcc4b0c1120e',
  },
};

function licenseText(name, text) {
  const hash = sha256(text);
  texts[hash] = text;
  return { file: name, sha256: hash };
}

for (const item of packages.values()) {
  const id = `${item.name}-${item.version}`;
  const archive = path.join(cache, `${id}.crate`);
  const url = `https://static.crates.io/crates/${item.name}/${id}.crate`;
  let bytes = await fs.readFile(archive).catch(() => undefined);
  if (!bytes || sha256(bytes) !== item.checksum) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== item.checksum) throw new Error(`Registry checksum mismatch: ${id}`);
    await fs.writeFile(archive, bytes);
  }
  const options = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  const listing = (await exec('tar', ['-tf', archive], options)).stdout.trim().split(/\r?\n/);
  if (listing.some(file => !file.startsWith(id + '/') || file.split('/').includes('..') || file.includes('\\'))) {
    throw new Error(`Unsafe crate archive paths: ${id}`);
  }
  const verbose = (await exec('tar', ['-tvf', archive], options)).stdout;
  if (verbose.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error(`Links are not allowed in license source archives: ${id}`);
  await exec('tar', ['-xf', archive, '-C', cache], options);
  const directory = path.join(cache, id);
  const metadata = (await readToml(path.join(directory, 'Cargo.toml'))).package;
  if (metadata.name !== item.name || metadata.version !== item.version) throw new Error(`Unexpected crate metadata: ${id}`);
  const files = listing.filter(file => /^(?:unlicense|license|licence|copying|copyright|notice)(?:[._-]|$)/i.test(path.basename(file)) && !file.endsWith('/'));
  // These archives put their complete MIT grant and copyright in AUTHORS.
  if (['r-efi-alloc-1.0.0', 'r-efi-4.5.0'].includes(id)) {
    const authors = await fs.readFile(path.join(directory, 'AUTHORS'), 'utf8');
    if (!authors.includes('AUTHORS-MIT:') || !authors.includes('Permission is hereby granted')) {
      throw new Error(`Missing embedded MIT grant: ${id}`);
    }
    files.push(`${id}/AUTHORS`);
  }
  const licenses = [];
  for (const file of files.sort()) {
    const relative = file.slice(id.length + 1);
    licenses.push(licenseText(relative, await fs.readFile(path.join(directory, relative), 'utf8')));
  }
  const extra = supplemental[id];
  let licenseSource;
  if (extra) {
    const vcs = JSON.parse(await fs.readFile(path.join(directory, '.cargo_vcs_info.json'), 'utf8'));
    if (vcs.git.sha1 !== extra.commit) throw new Error(`Unexpected source commit: ${id}`);
    licenseSource = `https://github.com/${extra.repository}/blob/${extra.commit}/${extra.file}`;
    const cached = path.join(cache, `${id}-upstream-LICENSE`);
    let text = await fs.readFile(cached, 'utf8').catch(() => undefined);
    if (!text) {
      const url = `https://api.github.com/repos/${extra.repository}/contents/${extra.file}?ref=${extra.commit}`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Vivado-License-Review' }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Cannot retrieve pinned upstream license: ${id}`);
      const result = await response.json();
      if (result.encoding !== 'base64' || result.sha !== extra.blob) throw new Error(`Unexpected upstream license: ${id}`);
      text = Buffer.from(result.content, 'base64').toString('utf8');
    }
    const bytes = Buffer.from(text);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== extra.blob) throw new Error(`Upstream license checksum mismatch: ${id}`);
    await fs.writeFile(cached, text);
    licenses.push(licenseText(`upstream/${extra.file}`, text));
  }
  if (!metadata.license || !licenses.length) throw new Error(`Missing upstream license: ${id}`);
  components.push({ ...item, source: url, licenseSource, license: metadata.license, licenses });
  console.log(`Notices: ${id} (${licenses.length} files)`);
}

const rustFiles = [
  ['COPYRIGHT', path.join(tools.sysroot, 'share/doc/rust/COPYRIGHT')],
  ['LICENSE-MIT', path.join(tools.sysroot, 'share/doc/rust/LICENSE-MIT')],
  ['LICENSE-APACHE', path.join(tools.sysroot, 'share/doc/rust/LICENSE-APACHE')],
];
for (const directory of ['stdarch', 'portable-simd', 'backtrace']) {
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    rustFiles.push([`library/${directory}/${file}`, path.join(stdRoot, directory, file)]);
  }
}
const rustLicenses = [];
for (const [name, filename] of rustFiles) rustLicenses.push(licenseText(name, await fs.readFile(filename, 'utf8')));
const notices = {
  format: 1, rustVersion: tools.expected,
  coverage: 'All registry packages in the application lockfile and pinned Rust library lockfile, conservatively including inactive and non-WASM platform dependencies.',
  applicationLockSha256: sha256(lock), rustLibraryLockSha256: sha256(stdLock),
  application, runtime,
  components: [...components, {
    name: 'Rust toolchain runtime', version: tools.expected, license: 'MIT OR Apache-2.0 (with third-party notices)',
    source: `https://github.com/rust-lang/rust/tree/${tools.expected}`, licenses: rustLicenses,
  }],
  texts,
};
await fs.writeFile(path.join(root, 'third_party/wasm-notices.json'), JSON.stringify(notices, null, 2) + '\n');
console.log(`Recorded ${components.length} crate versions and Rust runtime notices.`);
