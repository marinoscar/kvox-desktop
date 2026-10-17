#!/usr/bin/env node
// =============================================================================
// Vendor the five @marinoscar/kvox-* packages (temporary, until #577 publishes them)
// =============================================================================
//
// Builds @marinoscar/kvox-{contract,db,api,ai,web} from a marinoscar/kvox checkout,
// packs each with `npm pack` (what examples/bare-host/run.mjs --from pack does),
// copies the five tarballs to vendor/kvox/ and records where they came from in
// vendor/kvox/SOURCE.json. package.json depends on them through `file:` paths.
//
// Usage:
//   node scripts/vendor-kvox-packages.mjs [--kvox <dir>] [--ref <git ref>] [--skip-build]
//
//   --kvox <dir>   an existing marinoscar/kvox checkout. Without it the script
//                  clones https://github.com/marinoscar/kvox (shallow) into a
//                  temporary directory.
//   --ref <ref>    the branch, tag or commit to clone (default: main). Ignored
//                  with --kvox.
//   --skip-build   do not run `npm ci && npm run build:kvox-packages` (the
//                  checkout is already built).
//
// After it runs: `npm install` (the lockfile records the new tarball hashes),
// then commit vendor/kvox/ and package-lock.json together.
//
// Node built-ins only.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'kvox');
const PACKAGES = ['contract', 'db', 'api', 'ai', 'web'];
const REPO_URL = 'https://github.com/marinoscar/kvox';

function usage(message) {
  console.error(`vendor-kvox-packages: ${message}`);
  console.error('Usage: node scripts/vendor-kvox-packages.mjs [--kvox <dir>] [--ref <git ref>] [--skip-build]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { kvox: null, ref: 'main', build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--kvox') opts.kvox = resolve(argv[++i] ?? usage('--kvox needs a directory'));
    else if (arg === '--ref') opts.ref = argv[++i] ?? usage('--ref needs a value');
    else if (arg === '--skip-build') opts.build = false;
    else usage(`unknown argument '${arg}'`);
  }
  return opts;
}

function run(label, command, args, cwd) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`vendor-kvox-packages: "${label}" failed (exit ${result.status ?? 'signal'})`);
    process.exit(1);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const opts = parseArgs(process.argv.slice(2));

let checkout = opts.kvox;
let temp = null;
if (!checkout) {
  temp = mkdtempSync(join(tmpdir(), 'kvox-vendor-'));
  checkout = join(temp, 'kvox');
  run(`clone ${REPO_URL} (${opts.ref})`, 'git', ['clone', '--depth', '1', '--branch', opts.ref, REPO_URL, checkout], ROOT);
}
if (!existsSync(join(checkout, 'packages', 'kvox-api', 'package.json'))) usage(`${checkout} is not a marinoscar/kvox checkout`);

const commit = capture('git', ['rev-parse', 'HEAD'], checkout);

if (opts.build) {
  run('npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], checkout);
  run('npm run build:kvox-packages', 'npm', ['run', 'build:kvox-packages'], checkout);
}

const packDir = mkdtempSync(join(tmpdir(), 'kvox-pack-'));
for (const name of PACKAGES) {
  if (!existsSync(join(checkout, 'packages', `kvox-${name}`, 'dist'))) usage(`packages/kvox-${name}/dist is missing; build first`);
  run(`npm pack @marinoscar/kvox-${name}`, 'npm', ['pack', '--pack-destination', packDir], join(checkout, 'packages', `kvox-${name}`));
}

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });
const tarballs = {};
for (const name of PACKAGES) {
  const found = readdirSync(packDir).filter((file) => new RegExp(`^marinoscar-kvox-${name}-.*\\.tgz$`).test(file));
  if (found.length !== 1) throw new Error(`expected one marinoscar-kvox-${name}-*.tgz, found ${found.length}`);
  copyFileSync(join(packDir, found[0]), join(VENDOR, found[0]));
  const sha256 = createHash('sha256').update(readFileSync(join(VENDOR, found[0]))).digest('hex');
  const version = JSON.parse(readFileSync(join(checkout, 'packages', `kvox-${name}`, 'package.json'), 'utf8')).version;
  tarballs[`@marinoscar/kvox-${name}`] = { file: found[0], version, sha256 };
}
rmSync(packDir, { recursive: true, force: true });

const source = {
  $comment: 'Written by scripts/vendor-kvox-packages.mjs. Temporary until the packages are on npm (marinoscar/kvox#577).',
  repository: REPO_URL,
  commit,
  vendoredAt: new Date().toISOString(),
  tarballs,
};
writeFileSync(join(VENDOR, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
if (temp) rmSync(temp, { recursive: true, force: true });

console.log(`\nvendor-kvox-packages: vendored ${PACKAGES.length} packages from ${REPO_URL}@${commit}`);
console.log('Next: npm install, then commit vendor/kvox/ and package-lock.json together.');
