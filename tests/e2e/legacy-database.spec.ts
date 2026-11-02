import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { vector } from '@electric-sql/pglite-pgvector';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

import { homeHeading } from '../support/rail';

// =============================================================================
// A database from 0.1.0-rc.14 or earlier (the old `after-host` migration names)
// =============================================================================
//
// The user data folder holds a database that recorded a domain migration under
// its old name (`20260101000037_kvox_add_transcripts`, now
// `20260914130000_kvox_add_transcripts`) and a row of "user data". The app must
// start (no P3018), move `db/` aside to `db.legacy-<timestamp>/` with the row
// still in it, leave the vault where it is, and say where in one log line.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');
/** The extensions the app opens its database with (`PGLITE_EXTENSIONS`, src/server/database.ts). */
const extensions = { vector, pg_trgm, uuid_ossp };
const userDataDir = mkdtempSync(join(tmpdir(), 'kvox-e2e-legacy-'));
const mainLog: string[] = [];
let app: ElectronApplication | undefined;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test('a database from the old migration names is moved aside and kept, and the app starts fresh', async () => {
  test.setTimeout(300_000);
  const dataDir = join(userDataDir, 'db');
  mkdirSync(dataDir, { recursive: true });
  const old = await PGlite.create({ dataDir, extensions });
  await old.exec(`
    CREATE TABLE _prisma_migrations (migration_name text NOT NULL);
    INSERT INTO _prisma_migrations VALUES ('20260101000000_initial'), ('20260101000037_kvox_add_transcripts');
    CREATE TABLE legacy_marker (note text);
    INSERT INTO legacy_marker VALUES ('kept');`);
  await old.close();
  mkdirSync(join(userDataDir, 'vault'), { recursive: true });
  writeFileSync(join(userDataDir, 'vault', 'object'), 'vault bytes');

  const executablePath = process.env.KVOX_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, KVOX_USER_DATA_DIR: userDataDir },
    timeout: 120_000,
  });
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(...chunk.toString().split('\n').filter(Boolean)));
  const page = await app.firstWindow();
  await expect(homeHeading(page)).toBeVisible({ timeout: 180_000 });
  await app.close();
  app = undefined;

  const legacy = readdirSync(userDataDir).filter((name) => /^db\.legacy-\d{8}-\d{6}$/.test(name));
  expect(legacy).toHaveLength(1);
  const legacyDir = join(userDataDir, legacy[0]!);
  expect(mainLog.filter((line) => line.includes(legacyDir))).toHaveLength(1);
  expect(readFileSync(join(userDataDir, 'vault', 'object'), 'utf8')).toBe('vault bytes');

  const kept = await PGlite.create({ dataDir: legacyDir, extensions });
  try {
    expect((await kept.query<{ note: string }>('SELECT note FROM legacy_marker')).rows).toEqual([{ note: 'kept' }]);
  } finally {
    await kept.close();
  }
  // The new database holds the stable names.
  const fresh = await PGlite.create({ dataDir, extensions });
  try {
    const names = (await fresh.query<{ name: string }>('SELECT migration_name AS name FROM _prisma_migrations')).rows.map((r) => r.name);
    expect(names).toContain('20260914130000_kvox_add_transcripts');
    expect(names).not.toContain('20260101000037_kvox_add_transcripts');
  } finally {
    await fresh.close();
  }
});
