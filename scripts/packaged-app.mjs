#!/usr/bin/env node
// =============================================================================
// The packaged app, checked and prepared for the e2e tests (marinoscar/kvox#587)
// =============================================================================
//
//   node scripts/packaged-app.mjs locate
//       Prints the executable electron-builder left in release/*-unpacked
//       (this machine's architecture first).
//
//   node scripts/packaged-app.mjs verify [executable]
//       Fails unless the app (every unpacked architecture) is laid out as electron-builder.yml says: the app
//       in `app.asar`, the migration files and the Prisma schema engine in
//       `app.asar.unpacked`, no loose `resources/app` folder (Electron would
//       load it instead of the archive) and every fuse as configured.
//
//   node scripts/packaged-app.mjs test-copy [executable] [--in-place]
//       Playwright drives Electron through `--inspect`, which the shipped
//       binary refuses (EnableNodeCliInspectArguments off). This copies the
//       app next to itself (`release/e2e/`) with that ONE fuse turned back on
//       and prints the copy's executable; `--in-place` flips it in place (the
//       installed .deb, whose AppArmor profile names its path). Everything
//       else, the archive and the other fuses included, is what ships.
// =============================================================================

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fuses from '@electron/fuses';

const { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = fuses;
/** A fuse's byte on the wire (@electron/fuses does not export its FuseState). */
const FuseState = { DISABLE: 48, ENABLE: 49 };

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(projectDir, 'release');

/** The fuses of electron-builder.yml (`electronFuses`), as the binary must carry them. */
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};

/**
 * Every unpacked app under release/, this machine's architecture first
 * (`win-unpacked` and `mac` are x64; `win-arm64-unpacked`, `mac-arm64` arm64).
 */
export function unpackedApps(platform = process.platform, arch = process.arch) {
  const dirs = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  const prefix = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const exeOf = (dir) =>
    platform === 'win32'
      ? join(releaseDir, dir, 'KVox.exe')
      : platform === 'darwin'
        ? join(releaseDir, dir, 'KVox.app', 'Contents', 'MacOS', 'KVox')
        : join(releaseDir, dir, 'kvox-desktop');
  const archOf = (dir) => (/arm64/.test(dir) ? 'arm64' : /ia32/.test(dir) ? 'ia32' : /universal/.test(dir) ? 'universal' : 'x64');
  return dirs
    .filter((dir) => dir.startsWith(prefix) && statSync(join(releaseDir, dir)).isDirectory() && existsSync(exeOf(dir)))
    .sort((a, b) => Number(archOf(b) === arch) - Number(archOf(a) === arch))
    .map(exeOf);
}

/** The unpacked app's executable for this machine. */
export function locate(platform = process.platform) {
  const [first] = unpackedApps(platform);
  if (!first) throw new Error(`no packaged app under ${releaseDir} (run "npm run dist" first)`);
  return first;
}

/** `resources/` of an app, from its executable. */
export function resourcesOf(executable) {
  return executable.includes('.app/') ? resolve(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources');
}

/** Reads every fuse of a binary as booleans. */
export async function readFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  const fuses = {};
  for (const name of Object.keys(EXPECTED_FUSES)) {
    const state = wire[FuseV1Options[name]];
    fuses[name] = state === FuseState.ENABLE ? true : state === FuseState.DISABLE ? false : `state ${state}`;
  }
  return fuses;
}

async function verify(executable) {
  const resources = resourcesOf(executable);
  const unpacked = join(resources, 'app.asar.unpacked');
  const problems = [];
  const must = (ok, message) => ok || problems.push(message);

  must(existsSync(join(resources, 'app.asar')), 'resources/app.asar is missing (asar must be on)');
  must(!existsSync(join(resources, 'app')), 'resources/app exists: Electron would load it instead of app.asar');
  must(existsSync(join(unpacked, 'prisma.config.ts')), 'prisma.config.ts is not unpacked');
  const migrations = join(unpacked, 'prisma', 'migrations');
  const count = existsSync(migrations) ? readdirSync(migrations).filter((d) => /^\d{14}_/.test(d)).length : 0;
  must(count > 0, 'no migration is unpacked under prisma/migrations');
  const engines = join(unpacked, 'node_modules', '@prisma', 'engines');
  const engine = existsSync(engines) ? readdirSync(engines).find((name) => name.startsWith('schema-engine')) : undefined;
  must(engine !== undefined, 'the Prisma schema engine is not unpacked');

  const fuses = await readFuses(executable);
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    must(fuses[name] === expected, `fuse ${name} is ${fuses[name]}, expected ${expected}`);
  }

  console.log(`verify: ${relative(projectDir, executable) || executable}`);
  console.log(`verify: ${count} migration(s) and ${engine ?? 'no schema engine'} unpacked`);
  console.log(`verify: fuses ${JSON.stringify(fuses)}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify: FAIL ${problem}`);
    process.exit(1);
  }
  console.log('verify: ok');
}

/** Copies the app (or takes it in place) and turns --inspect back on, for Playwright. */
async function testCopy(executable, inPlace) {
  let target = executable;
  if (!inPlace) {
    // The whole app: the .app bundle on macOS, the unpacked folder elsewhere.
    const appRoot = executable.includes('.app/') ? executable.slice(0, executable.indexOf('.app/') + 4) : dirname(executable);
    const copyRoot = join(releaseDir, 'e2e', basename(appRoot));
    rmSync(join(releaseDir, 'e2e'), { recursive: true, force: true });
    cpSync(appRoot, copyRoot, { recursive: true, verbatimSymlinks: true });
    target = join(copyRoot, relative(appRoot, executable));
  }
  await flipFuses(target, {
    version: FuseVersion.V1,
    // The copy is re-signed ad hoc on macOS (flipping a fuse breaks the signature).
    resetAdHocDarwinSignature: process.platform === 'darwin',
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
  console.log(target);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const given = rest.find((arg) => !arg.startsWith('--'));
  const executable = given ? resolve(given) : undefined;
  if (command === 'locate') console.log(locate());
  else if (command === 'verify') {
    const all = executable ? [executable] : unpackedApps();
    if (all.length === 0) locate();
    for (const app of all) await verify(app);
  }
  else if (command === 'test-copy') await testCopy(executable ?? locate(), rest.includes('--in-place'));
  else {
    console.error('usage: packaged-app.mjs locate | verify [executable] | test-copy [executable] [--in-place]');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
