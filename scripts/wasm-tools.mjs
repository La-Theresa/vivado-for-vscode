import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const crate = path.join(root, 'wasm/vcd-parser');
export const target = 'wasm32-unknown-unknown';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
export const readToml = async filename => parse(await fs.readFile(filename, 'utf8'));
const exec = promisify(execFile);

export async function rustTools() {
  const env = { ...process.env };
  const local = path.join(root, '.tools');
  const hasLocal = await fs.access(path.join(local, 'cargo/bin')).then(() => true, () => false);
  if (hasLocal && !env.CARGO_HOME && !env.RUSTUP_HOME) {
    env.CARGO_HOME = path.join(local, 'cargo');
    env.RUSTUP_HOME = path.join(local, 'rustup');
  }
  const command = name => env.CARGO_HOME
    ? path.join(env.CARGO_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const run = async (name, args, extraEnv = {}) => {
    try {
      const result = await exec(command(name), args, {
        cwd: crate, env: { ...env, ...extraEnv }, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      });
      if (result.stderr) process.stderr.write(result.stderr);
      return result.stdout.trim();
    } catch (error) {
      throw new Error(`${name} ${args.join(' ')} failed. Install the pinned toolchain from wasm/vcd-parser/rust-toolchain.toml.\n${error.stderr || error.message}`);
    }
  };
  const expected = (await readToml(path.join(crate, 'rust-toolchain.toml'))).toolchain.channel;
  const version = await run('rustc', ['--version', '--verbose']);
  if (!version.split(/\r?\n/).includes(`release: ${expected}`)) throw new Error('Wrong Rust toolchain version.');
  return { run, env, version, expected, sysroot: await run('rustc', ['--print', 'sysroot']) };
}

export async function sourceHashes() {
  const files = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src/lib.rs'].map(file => `wasm/vcd-parser/${file}`);
  files.push('scripts/build-wasm.mjs', 'scripts/wasm-tools.mjs', 'scripts/wasm-notices.mjs', 'third_party/wasm-notices.json', 'LICENSE', '.gitattributes');
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await fs.readFile(path.join(root, file)))])));
}

export function lockedPackages(lock) {
  return lock.package.filter(item => item.source).map(item => {
    if (item.source !== 'registry+https://github.com/rust-lang/crates.io-index' || !/^[a-f0-9]{64}$/.test(item.checksum)) {
      throw new Error(`Unaudited Rust source: ${item.name}`);
    }
    return { name: item.name, version: item.version, checksum: item.checksum };
  }).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
