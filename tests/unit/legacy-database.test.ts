import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { PGLITE_EXTENSIONS, installedMigrations, spawnNodeScript, startDatabase } from '../../src/server/database';
import { legacyStamp, moveDatabaseAside, renamedDomainMigrations } from '../../src/server/legacy-database';
import { ROOT, removeQuietly } from './support/database';

// =============================================================================
// The switch to stable domain migration names, and what happens to a database
// created under the old (`after-host`) names of rc.14 and earlier
// =============================================================================

const work = mkdtempSync(join(tmpdir(), 'kvox-legacy-'));
afterAll(() => removeQuietly(work));

/** The kvox-db package's migration ids (`<14 digits>_<slug>`). */
function packageMigrationIds(): string[] {
  const dir = join(ROOT, 'node_modules', '@marinoscar', 'kvox-db', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('stable domain migration names (scripts/prepare-db.mjs)', () => {
  it('installs every domain migration as <the package id timestamp>_kvox_<slug>, whatever the platform count', () => {
    const installed = installedMigrations(ROOT);
    const domain = installed.filter((name) => /^\d{14}_kvox_/.test(name));
    const expected = packageMigrationIds().map((id) => id.replace(/^(\d{14})_/, '$1_kvox_'));
    expect(expected.length).toBeGreaterThan(0);
    expect(domain.sort()).toEqual(expected.sort());
    // The two oldest, pinned literally: a rename here breaks every user database.
    expect(installed).toContain('20260914130000_kvox_add_transcripts');
    expect(installed).toContain('20260914140000_kvox_add_notes');
  });

  it('sorts every platform migration before the first domain migration', () => {
    const installed = installedMigrations(ROOT).sort();
    const firstDomain = installed.findIndex((name) => name.includes('_kvox_'));
    expect(firstDomain).toBeGreaterThan(0);
    expect(installed.slice(firstDomain).every((name) => name.includes('_kvox_'))).toBe(true);
  });
});

describe('renamedDomainMigrations', () => {
  const installed = ['20260101000000_initial', '20260914130000_kvox_add_transcripts', '20260914140000_kvox_add_notes'];

  it('flags a domain migration recorded under an old after-host name', () => {
    expect(
      renamedDomainMigrations(['20260101000000_initial', '20260101000037_kvox_add_transcripts', '20260101000038_kvox_add_notes'], installed),
    ).toEqual(['20260101000037_kvox_add_transcripts', '20260101000038_kvox_add_notes']);
  });

  it('passes a database on the stable names, a new one, and one from a newer build', () => {
    expect(renamedDomainMigrations(installed, installed)).toEqual([]);
    expect(renamedDomainMigrations([], installed)).toEqual([]);
    // Unknown slug (a newer build): not a rename; `migrate deploy` reports it.
    expect(renamedDomainMigrations([...installed, '20270101000000_kvox_add_something_new'], installed)).toEqual([]);
    // A platform name this build does not ship: not a domain rename.
    expect(renamedDomainMigrations(['20250101000000_initial'], installed)).toEqual([]);
  });
});

describe('moveDatabaseAside', () => {
  it('renames the folder to a sibling <folder>.legacy-<timestamp> and deletes nothing', async () => {
    const root = join(work, 'move');
    const db = join(root, 'db');
    mkdirSync(join(db, 'base'), { recursive: true });
    writeFileSync(join(db, 'base', 'marker'), 'legacy marker');
    mkdirSync(join(root, 'vault'), { recursive: true });
    writeFileSync(join(root, 'vault', 'object'), 'vault bytes');
    const now = new Date('2026-11-02T15:30:45.123Z');

    const moved = await moveDatabaseAside(db, now);

    expect(moved).toBe(join(root, `db.legacy-${legacyStamp(now)}`));
    expect(legacyStamp(now)).toBe('20261102-153045');
    expect(existsSync(db)).toBe(false);
    expect(readFileSync(join(moved, 'base', 'marker'), 'utf8')).toBe('legacy marker');
    expect(readFileSync(join(root, 'vault', 'object'), 'utf8')).toBe('vault bytes');

    // The same second again: a second sibling, the first one untouched.
    mkdirSync(db);
    writeFileSync(join(db, 'second'), 'second');
    const again = await moveDatabaseAside(db, now);
    expect(again).toBe(`${moved}-2`);
    expect(readFileSync(join(moved, 'base', 'marker'), 'utf8')).toBe('legacy marker');
    expect(readFileSync(join(again, 'second'), 'utf8')).toBe('second');
  });
});

describe('startDatabase on a database from rc.14 or earlier', () => {
  it('moves it aside, keeps it, and starts a new migrated database', async () => {
    const userDataDir = join(work, 'profile');
    const dataDir = join(userDataDir, 'db');
    mkdirSync(dataDir, { recursive: true });
    // A stand-in for an old database: the old domain name recorded, and a row of "user data".
    const old = await PGlite.create({ dataDir, extensions: PGLITE_EXTENSIONS });
    await old.exec(`
      CREATE TABLE _prisma_migrations (migration_name text NOT NULL);
      INSERT INTO _prisma_migrations VALUES ('20260101000000_initial'), ('20260101000037_kvox_add_transcripts');
      CREATE TABLE legacy_marker (note text);
      INSERT INTO legacy_marker VALUES ('kept');`);
    await old.close();
    mkdirSync(join(userDataDir, 'vault'), { recursive: true });
    writeFileSync(join(userDataDir, 'vault', 'object'), 'vault bytes');

    const lines: string[] = [];
    const database = await startDatabase({ appRoot: ROOT, dataDir, runScript: spawnNodeScript(process.execPath), log: (line) => lines.push(line) });
    try {
      expect(database.legacyDataDir).toMatch(/[\\/]db\.legacy-\d{8}-\d{6}$/);
      expect(database.applied).toBeGreaterThan(0);
      const moveLines = lines.filter((line) => line.includes(database.legacyDataDir!));
      expect(moveLines).toHaveLength(1);
    } finally {
      await database.close();
    }

    // Only the database folder moved; the old database still opens with its data.
    expect(readFileSync(join(userDataDir, 'vault', 'object'), 'utf8')).toBe('vault bytes');
    const kept = await PGlite.create({ dataDir: database.legacyDataDir!, extensions: PGLITE_EXTENSIONS });
    try {
      expect((await kept.query<{ note: string }>('SELECT note FROM legacy_marker')).rows).toEqual([{ note: 'kept' }]);
    } finally {
      await kept.close();
    }

    // The next start finds a current database: nothing moved again.
    const second = await startDatabase({ appRoot: ROOT, dataDir, runScript: spawnNodeScript(process.execPath), log: () => undefined });
    try {
      expect(second.legacyDataDir).toBeUndefined();
      expect(second.applied).toBe(0);
    } finally {
      await second.close();
    }
    expect(readdirSync(userDataDir).filter((name) => name.startsWith('db.legacy-'))).toHaveLength(1);
  });
});
