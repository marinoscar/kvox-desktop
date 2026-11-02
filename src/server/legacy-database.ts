import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';

// =============================================================================
// A database from before the stable migration names (KVox Desktop 0.1.0-rc.14
// and earlier)
// =============================================================================
//
// Up to rc.14, `scripts/prepare-db.mjs` installed the domain migrations with
// kvox-db's `after-host` names: `<one second after the newest platform
// migration>_kvox_<slug>`. Every platform release that added a migration moved
// every domain name, so a database from an older build fails `prisma migrate
// deploy` (P3018: it re-runs a domain migration whose objects already exist).
// Since then the names are `stable`: `<the package id's timestamp>_kvox_<slug>`,
// which no later release changes.
//
// THE RULE, read from `_prisma_migrations` BEFORE `migrate deploy`: the
// database is legacy when it recorded a domain migration (`<14 digits>_kvox_<slug>`)
// that this app does not ship under that name but DOES ship under another name
// with the same slug. That is exactly a renamed domain migration. A migration
// the app does not know at all (a database from a newer build) is not this
// case and is left alone: `migrate deploy` reports it.
//
// THE MOVE: the database folder (`<userData>/db`, PGlite's data directory and
// nothing else) is renamed to a sibling `db.legacy-<UTC timestamp>` and kept;
// nothing is deleted. The vault, the logs, `secrets.bin`, `settings.json` and
// the note files the user's libraries point at stay where they are. The app
// then starts on a new, empty database. The user accepted this for the switch:
// the notes are files, added again from their folders.
// =============================================================================

/** A domain migration installed by kvox-db: `<14-digit timestamp>_kvox_<slug>`. */
const DOMAIN_MIGRATION = /^(\d{14})_kvox_(.+)$/;

/** The slug of a domain migration name, or `undefined` for any other name. */
function domainSlug(name: string): string | undefined {
  return DOMAIN_MIGRATION.exec(name)?.[2];
}

/**
 * The recorded migration names that are domain migrations this app ships under
 * a DIFFERENT name: the mark of a database created under the old naming.
 *
 * @param recorded - the `migration_name`s of `_prisma_migrations` (any state).
 * @param installed - the migration directory names this app ships (`prisma/migrations`).
 * @returns the renamed names; empty when the database can be migrated as it is.
 */
export function renamedDomainMigrations(recorded: readonly string[], installed: readonly string[]): string[] {
  const shipped = new Set(installed);
  const shippedSlugs = new Set(installed.map(domainSlug).filter((slug): slug is string => slug !== undefined));
  return recorded.filter((name) => {
    if (shipped.has(name)) return false;
    const slug = domainSlug(name);
    return slug !== undefined && shippedSlugs.has(slug);
  });
}

/** `20261102-153000`: a UTC timestamp a folder name can carry on every system. */
export function legacyStamp(now: Date): string {
  const iso = now.toISOString(); // 2026-11-02T15:30:00.000Z
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Moves a database folder aside to `<folder>.legacy-<timestamp>` (a sibling)
 * and returns the new path. Never deletes: when that name is taken, a counter
 * is appended. The caller must have closed the database first.
 */
export async function moveDatabaseAside(dataDir: string, now: Date = new Date()): Promise<string> {
  const base = `${dataDir}.legacy-${legacyStamp(now)}`;
  let target = base;
  for (let n = 2; existsSync(target); n += 1) target = `${base}-${n}`;
  await rename(dataDir, target);
  return target;
}
