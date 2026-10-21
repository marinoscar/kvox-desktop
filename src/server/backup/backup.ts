import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import yauzl from 'yauzl';
import yazl from 'yazl';

import type { DataFolder } from '../data-folder.js';

// =============================================================================
// Export data / Restore: the `.kvoxbackup` archive (marinoscar/kvox#583)
// =============================================================================
//
// Desktop-only glue: the data folder is the host's, so is its backup. A
// `.kvoxbackup` is a zip of
//
//   db.tar.gz       PGlite's data directory after a checkpoint (`dumpDataDir`):
//                   every table, so notes, transcripts, the graph, jobs and the
//                   KVOX_SETTINGS values
//   vault/<key>     every object file, byte for byte
//   manifest.json   written LAST: format and version, the app version, the
//                   migrations the database had, and every file's size and
//                   SHA-256
//
// NOT in a backup: `models/` (the on-device embedding model, marinoscar/kvox#660: re-downloadable, and
// the same rule: only `db/` and `vault/` are archived), `copilot/` (the Copilot runtime's sessions, sign-in material and downloaded
// runtime: marinoscar/kvox-desktop#23; the archive is built from `db/` and `vault/` only, a restore
// replaces only those two, and an archive with any other entry is refused), `secrets.bin` (its blobs only decrypt for this OS user on
// this machine; enter the API key again after a restore on another one),
// `settings.json` (the shell's preferences) and `logs/`.
//
// RESTORE is two steps because PGlite is single-writer and is serving the very
// job that restores:
//
//   1. {@link stageRestore} (the restore job): unpack into `restore-staging/`,
//      refuse any entry outside it, check every file against the manifest
//      (size, SHA-256, nothing missing, nothing extra), refuse a backup whose
//      database has a migration this app does not know (a newer app made it),
//      then rename the folder to `restore-pending/` (atomic: a crash leaves
//      either nothing or a complete, checked restore).
//   2. {@link applyPendingRestore} (the next server start, before PGlite opens):
//      move `db/` and `vault/` aside to `restore-previous/`, load the dump into a
//      new `db/`, move the vault in. Any failure puts the previous folders back.
//      `restore-previous/` is removed once the restored database has migrated
//      (`discardPreviousData`).
//
// Archives are written to `<target>.partial` and renamed, so a failed export
// never leaves a file that looks complete.
// =============================================================================

/** The `format` of a manifest. */
export const BACKUP_FORMAT = 'kvoxbackup';
/** The manifest version this app writes and reads. */
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST = 'manifest.json';
const DB_DUMP = 'db.tar.gz';
const READY = '.ready';

/** One file of an archive. */
export interface BackupFile {
  /** `db.tar.gz` or `vault/<storage key>` (always `/`-separated). */
  path: string;
  size: number;
  sha256: string;
}

/** `manifest.json`. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  app: { name: string; version: string };
  /** The `_prisma_migrations` names the database had applied. */
  migrations: string[];
  files: BackupFile[];
}

/** Why an archive was refused. */
export class BackupInvalidError extends Error {
  constructor(message: string) {
    super(`This is not a usable KVox backup: ${message}`);
    this.name = 'BackupInvalidError';
  }
}

/** What {@link writeBackup} reads. */
export interface BackupSource {
  folder: DataFolder;
  /** `DesktopDatabase.dump()`. */
  dumpDatabase(): Promise<Uint8Array>;
  /** The applied migration names. */
  migrations(): Promise<string[]>;
  appVersion: string;
}

/** A hashing pass-through. */
function hashing(onDone: (sha256: string, size: number) => void): Transform {
  const hash = createHash('sha256');
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      onDone(hash.digest('hex'), size);
      callback();
    },
  });
}

/** Every file under a folder, as `/`-separated relative paths, sorted. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

/** Writes a `.kvoxbackup` of the data folder to `target`. */
export async function writeBackup(source: BackupSource, target: string): Promise<BackupManifest> {
  if (!isAbsolute(target)) throw new Error('The backup target must be an absolute path');
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const zip = new yazl.ZipFile();
  const written = pipeline(zip.outputStream, createWriteStream(partial));
  let ended = false;
  const end = (): void => {
    if (!ended) zip.end();
    ended = true;
  };
  const files: BackupFile[] = [];

  try {
    // The database first: the vault walk then sees at least every object the dump references.
    const dump = Buffer.from(await source.dumpDatabase());
    const migrations = await source.migrations();
    zip.addBuffer(dump, DB_DUMP, { compress: false });
    files.push({ path: DB_DUMP, size: dump.length, sha256: createHash('sha256').update(dump).digest('hex') });

    for (const key of await filesUnder(source.folder.vault)) {
      const path = `vault/${key}`;
      const file = join(source.folder.vault, ...key.split('/'));
      const { size } = await stat(file);
      // Hash in a first pass so the manifest (and the entry) never disagree with what was read.
      const digest = await new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', () => resolve(hash.digest('hex')));
      });
      zip.addReadStream(createReadStream(file), path, { compress: false, size });
      files.push({ path, size, sha256: digest });
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      app: { name: 'KVox Desktop', version: source.appVersion },
      migrations,
      files,
    };
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), MANIFEST);
    end();
    await written;
    await rename(partial, target);
    return manifest;
  } catch (error) {
    end();
    await written.catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

/** True for an archive entry name that stays inside the folder it is unpacked into. */
function safeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  const parts = name.split('/');
  return !parts.includes('..') && !parts.includes('.') && parts.every((part) => part !== '');
}

/** Unpacks every entry into `dir`, answering each file's size and hash. */
async function unpack(archive: string, dir: string): Promise<Map<string, { size: number; sha256: string }>> {
  const seen = new Map<string, { size: number; sha256: string }>();
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) =>
      error || !file ? reject(new BackupInvalidError(error?.message ?? 'unreadable zip')) : resolve(file),
    ),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (error: Error) => reject(new BackupInvalidError(error.message)));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (name.endsWith('/')) return zip.readEntry(); // a directory entry
        const allowed = name === MANIFEST || name === DB_DUMP || (name.startsWith('vault/') && safeEntryName(name));
        if (!allowed || !safeEntryName(name)) return reject(new BackupInvalidError(`unexpected entry "${name}"`));
        if (seen.has(name)) return reject(new BackupInvalidError(`duplicate entry "${name}"`));
        const target = join(dir, ...name.split('/'));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(new BackupInvalidError(error?.message ?? `unreadable entry "${name}"`));
          mkdir(dirname(target), { recursive: true })
            .then(() =>
              pipeline(
                stream,
                hashing((sha256, size) => seen.set(name, { sha256, size })),
                createWriteStream(target),
              ),
            )
            .then(() => zip.readEntry())
            .catch((cause: unknown) => reject(cause instanceof BackupInvalidError ? cause : new BackupInvalidError(String(cause))));
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return seen;
}

/** Reads and checks a manifest's shape. */
function parseManifest(text: string): BackupManifest {
  let manifest: Partial<BackupManifest>;
  try {
    manifest = JSON.parse(text) as Partial<BackupManifest>;
  } catch {
    throw new BackupInvalidError('the manifest is not JSON');
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupInvalidError('the manifest is not a KVox backup manifest');
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupInvalidError(`format version ${String(manifest.formatVersion)} is not supported (this app reads ${BACKUP_FORMAT_VERSION})`);
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.migrations)) throw new BackupInvalidError('the manifest is incomplete');
  return manifest as BackupManifest;
}

/**
 * Checks an archive and stages it for the next server start (step 1).
 *
 * @param knownMigrations - the migration names this app ships (`prisma/migrations`).
 */
export async function stageRestore(folder: DataFolder, archive: string, knownMigrations: readonly string[]): Promise<BackupManifest> {
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile()) throw new BackupInvalidError('the file does not exist');
  await rm(folder.restoreStaging, { recursive: true, force: true });
  await mkdir(folder.restoreStaging, { recursive: true });
  try {
    const seen = await unpack(archive, folder.restoreStaging);
    if (!seen.has(MANIFEST)) throw new BackupInvalidError('the manifest is missing');
    const manifest = parseManifest(await readFile(join(folder.restoreStaging, MANIFEST), 'utf8'));

    const listed = new Set<string>();
    for (const file of manifest.files) {
      const got = seen.get(file.path);
      if (!got) throw new BackupInvalidError(`"${file.path}" is listed but missing`);
      if (got.size !== file.size || got.sha256 !== file.sha256) throw new BackupInvalidError(`"${file.path}" does not match its checksum`);
      listed.add(file.path);
    }
    for (const name of seen.keys()) {
      if (name !== MANIFEST && !listed.has(name)) throw new BackupInvalidError(`"${name}" is not in the manifest`);
    }
    if (!listed.has(DB_DUMP)) throw new BackupInvalidError('the database dump is missing');
    const known = new Set(knownMigrations);
    const unknown = manifest.migrations.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new BackupInvalidError(`it was made by a newer KVox Desktop (unknown migrations: ${unknown.slice(0, 3).join(', ')})`);
    }

    await mkdir(join(folder.restoreStaging, 'vault'), { recursive: true });
    await writeFile(join(folder.restoreStaging, READY), `${randomUUID()}\n`);
    await rm(folder.restorePending, { recursive: true, force: true });
    await rename(folder.restoreStaging, folder.restorePending);
    return manifest;
  } catch (error) {
    await rm(folder.restoreStaging, { recursive: true, force: true });
    throw error;
  }
}

/** True when a checked restore waits for the next start. */
export function hasPendingRestore(folder: DataFolder): boolean {
  return existsSync(join(folder.restorePending, READY));
}

/**
 * Applies a staged restore (step 2). Call it before PGlite opens `db/`.
 *
 * @param extensions - the PGlite extensions the database is opened with.
 * @returns true when a restore was applied.
 */
export async function applyPendingRestore(
  folder: DataFolder,
  extensions: PGliteOptions['extensions'],
  log: (line: string) => void,
): Promise<boolean> {
  if (!hasPendingRestore(folder)) {
    // A staging folder is an export of a restore that never finished checking.
    await rm(folder.restoreStaging, { recursive: true, force: true });
    return false;
  }
  log('restore: applying the staged backup');
  await rm(folder.restorePrevious, { recursive: true, force: true });
  await mkdir(folder.restorePrevious, { recursive: true });
  const previousDb = join(folder.restorePrevious, 'db');
  const previousVault = join(folder.restorePrevious, 'vault');
  if (existsSync(folder.db)) await rename(folder.db, previousDb);
  if (existsSync(folder.vault)) await rename(folder.vault, previousVault);
  try {
    await mkdir(folder.db, { recursive: true });
    const dump = await readFile(join(folder.restorePending, DB_DUMP));
    const db = await PGlite.create({ dataDir: folder.db, extensions, loadDataDir: new Blob([dump]) });
    await db.query('SELECT 1');
    await db.close();
    await rename(join(folder.restorePending, 'vault'), folder.vault);
    await rm(folder.restorePending, { recursive: true, force: true });
    log('restore: the backup is in place');
    return true;
  } catch (error) {
    await rm(folder.db, { recursive: true, force: true });
    await rm(folder.vault, { recursive: true, force: true });
    if (existsSync(previousDb)) await rename(previousDb, folder.db);
    if (existsSync(previousVault)) await rename(previousVault, folder.vault);
    await rm(folder.restorePending, { recursive: true, force: true });
    log(`restore: failed, the previous data is back in place: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Removes what a restore replaced, once the restored database has opened and migrated. */
export async function discardPreviousData(folder: DataFolder): Promise<void> {
  await rm(folder.restorePrevious, { recursive: true, force: true });
}

/** The migration directory names the app ships. */
export async function shippedMigrations(appRoot: string): Promise<string[]> {
  const entries = await readdir(join(appRoot, 'prisma', 'migrations'), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
