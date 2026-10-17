import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// =============================================================================
// The embedded PostgreSQL of KVox Desktop (marinoscar/kvox#582)
// =============================================================================
//
// PGlite (PostgreSQL in WebAssembly) runs INSIDE this utility process, with its
// files under `<userData>/db`. It is served on a loopback socket (127.0.0.1, a
// port the system picks, one connection) because Prisma reaches it through the
// `pg` driver adapter and because `prisma migrate deploy` and
// `kvox-db check --database` are separate processes. This is the bare host's
// PGlite leg (examples/bare-host/src/db.ts) with a data directory instead of
// memory.
//
// THE SEQUENCE, every launch:
//   1. open PGlite with vector, pg_trgm and uuid_ossp (the first platform
//      migration creates "uuid-ossp"), then create `vector` and `pg_trgm`
//      (the superuser's job, never a migration's; the only SQL in this repo);
//   2. `prisma migrate deploy` (platform history, then the domain history);
//   3. `kvox-db check --database`, only when step 2 applied something (the
//      first launch and every upgrade), because it costs a process start.
//
// A RESTORE is applied before step 1 (`applyPendingRestore` in
// `backup/backup.ts`): PGlite is single-writer, so the data directory can only
// be swapped while nothing has it open.
//
// The child processes run on the Electron binary in Node mode
// (ELECTRON_RUN_AS_NODE), so a packaged app needs no separate Node. Prisma's
// update check and telemetry are switched off: the AI provider is the only
// egress the app may have.
//
// PGlite is ONE session: the Prisma pool is one connection (see the bare
// host's notes on deadlocks in `pg-table-jobs.ts`).
// =============================================================================

/** A started database. */
export interface DesktopDatabase {
  /** The loopback connection URL. */
  readonly url: string;
  /** How many migrations this launch applied. */
  readonly applied: number;
  /** Milliseconds per step, for the cold-start report. */
  readonly timings: Record<string, number>;
  /** A gzip tarball of the data directory after a checkpoint (`PGlite.dumpDataDir`), for a backup. */
  dump(): Promise<Uint8Array>;
  /** Stops the socket and closes PGlite (flushes its files). Safe to call twice. */
  close(): Promise<void>;
}

/** Where the app's own files are (`prisma/`, `prisma.config.ts`, `node_modules/`). */
export interface DatabaseOptions {
  /** `app.getAppPath()`: the directory holding `prisma/` and `node_modules/`. */
  appRoot: string;
  /** The PGlite data directory, `<userData>/db`. */
  dataDir: string;
  /** The Electron binary, run with ELECTRON_RUN_AS_NODE=1 for the child processes. */
  nodeExecutable: string;
  /** Receives progress lines. */
  log: (line: string) => void;
}

/** The `bin` script of an installed package. */
function binOf(appRoot: string, pkg: string, name: string): string {
  // Resolved from the app root (not this bundle), which also works where `require` is not a global (the tests).
  const manifestPath = createRequire(join(appRoot, 'package.json')).resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> };
  return join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name]);
}

/**
 * Runs a node script with a connection URL. ASYNC ON PURPOSE: PGlite lives in
 * this process, and a synchronous child-process call would block the event
 * loop that serves it.
 */
function runNode(options: DatabaseOptions, label: string, script: string, args: string[], databaseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.nodeExecutable, [script, ...args], {
      cwd: options.appRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DATABASE_URL: databaseUrl,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        PRISMA_DISABLE_WARNINGS: '1',
        NO_UPDATE_NOTIFIER: '1',
      },
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} failed (exit ${code}):\n${output}`));
    });
  });
}

/** A free loopback port (bound and released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** The extensions every open of the data directory loads (a restore loads the same). */
export const PGLITE_EXTENSIONS = { vector, pg_trgm, uuid_ossp };

/** Opens PGlite, applies every migration and, after a change, proves the domain objects exist. */
export async function startDatabase(options: DatabaseOptions): Promise<DesktopDatabase> {
  const timings: Record<string, number> = {};
  const time = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      timings[step] = Math.round(performance.now() - started);
    }
  };

  mkdirSync(options.dataDir, { recursive: true });
  const db = await time('pgliteOpen', () =>
    PGlite.create({ dataDir: options.dataDir, extensions: PGLITE_EXTENSIONS }),
  );
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable&connection_limit=1`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server.stop();
    await db.close();
  };
  const dump = async (): Promise<Uint8Array> => {
    await db.exec('CHECKPOINT');
    return new Uint8Array(await (await db.dumpDataDir('gzip')).arrayBuffer());
  };

  try {
    options.log('database: migrating');
    const output = await time('migrateDeploy', () =>
      runNode(
        options,
        'prisma migrate deploy',
        binOf(options.appRoot, 'prisma', 'prisma'),
        ['migrate', 'deploy', '--config', join(options.appRoot, 'prisma.config.ts')],
        url,
      ),
    );
    // Prisma lists each applied migration's directory under "have been applied".
    const applied = /have been applied/.test(output) ? (output.match(/[└├]─ \d{14}_/g)?.length ?? 1) : 0;
    if (applied > 0) {
      options.log(`database: ${applied} migration(s) applied; checking the domain objects`);
      const report = await time('kvoxDbCheck', () =>
        runNode(
          options,
          'kvox-db check --database',
          binOf(options.appRoot, '@marinoscar/kvox-db', 'kvox-db'),
          ['check', '--root', options.appRoot, '--database'],
          url,
        ),
      );
      options.log(report.trim());
    } else {
      options.log('database: no pending migrations');
    }
    return { url, applied, timings, dump, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** A Prisma client over the `pg` driver adapter: one connection, because PGlite is one session. */
export function createPrismaClient(database: DesktopDatabase): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url, max: 1 }) });
}
