#!/usr/bin/env node
// =============================================================================
// Prepare KVox Desktop's database layer (marinoscar/kvox#582)
// =============================================================================
//
// Builds, from scratch, the Prisma schema, the migration history and the client
// the bare host runs on. It needs no database: composing a schema, installing
// migration files and generating a client do not connect.
//
//   1. `platform db sync`     installs the platform migrations (byte copies).
//   2. `platform db compose`  composes the platform schema; the domain installer
//                             refuses a host without `User`, `StorageObject`, `Job`.
//   3. `kvox-db sync`         installs the domain fragments and migrations under
//                             `--names after-host`. A host with no domain history
//                             would otherwise sort the September-dated domain
//                             migrations BEFORE the platform tables they
//                             reference. This is why step 1 comes first: the new
//                             names are "one second after the newest directory".
//   4. `platform db compose`  again, now with the domain fragments.
//   5. `prisma generate`      the client lands in node_modules/.prisma/client of
//                             this (temporary) project.
//
// Everything it writes (`prisma/`) is git-ignored and removed first, so a run
// is the same on a fresh checkout and on a developer's machine.
//
// Copied from marinoscar/kvox examples/bare-host/scripts/prepare-db.mjs, with
// one change: `platform db sync` gets a FIXED `--timestamp`. Without it the
// installed directory names carry the build's wall clock, so two builds of the
// same package versions would name the same migrations differently and an
// existing user database (`_prisma_migrations`) would no longer match the
// app's history. A fixed clock makes the names a function of the package
// versions only. Names still shift when an upgrade adds a platform migration;
// see the README ("Database migrations") for that open point.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectDir, 'package.json'));

/** The `bin` script of an installed package. */
function binOf(pkg, name) {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
  return join(dirname(manifestPath), rel);
}

/** Runs a node script in the project directory; stops the whole preparation on failure. */
function run(label, script, args) {
  console.log(`prepare-db: ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: projectDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`prepare-db: "${label}" failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

const platform = binOf('@marinoscar/platform-db', 'platform');
const kvoxDb = binOf('@marinoscar/kvox-db', 'kvox-db');
const prisma = binOf('prisma', 'prisma');

rmSync(join(projectDir, 'prisma'), { recursive: true, force: true });

/** The clock of the installed directory names: fixed, so a rebuild names them the same. */
const MIGRATION_CLOCK = '2026-01-01T00:00:00.000Z';

run('install the platform migrations', platform, ['db', 'sync', '--root', projectDir, '--timestamp', MIGRATION_CLOCK]);
run('compose the platform schema', platform, ['db', 'compose', '--root', projectDir]);
run('install the domain fragments and migrations (after-host names)', kvoxDb, [
  'sync',
  '--root',
  projectDir,
  '--names',
  'after-host',
]);
run('compose the platform and domain schema', platform, ['db', 'compose', '--root', projectDir]);
run('generate the Prisma client', prisma, ['generate', '--config', join(projectDir, 'prisma.config.ts')]);

console.log('prepare-db: ready');
