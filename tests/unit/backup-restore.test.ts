import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';

import {
  BackupInvalidError,
  applyPendingRestore,
  discardPreviousData,
  hasPendingRestore,
  shippedMigrations,
  stageRestore,
} from '../../src/server/backup/backup';
import { BACKUP_EXPORT_JOB, BACKUP_RESTORE_JOB, BACKUP_SUBJECT, registerBackupJobs } from '../../src/server/backup/backup-jobs';
import { dataFolder } from '../../src/server/data-folder';
import { PGLITE_EXTENSIONS } from '../../src/server/database';
import { LocalFsObjectStore } from '../../src/server/ports/local-fs-object-store';
import { PgTableJobs } from '../../src/server/ports/pg-table-jobs';
import { LOCAL_USER_ID } from '../../src/server/seed';
import { ROOT, openTestDatabase, removeQuietly, type TestDatabase } from './support/database';

// =============================================================================
// Backup then restore on a fresh profile (marinoscar/kvox#583)
// =============================================================================
//
// Profile A gets notes, graph entities and vault files; "Export data" runs as a
// job and writes a `.kvoxbackup`. Profile B is a brand-new user data folder:
// "Restore" runs as a job (it checks and stages the archive), then the next
// start applies it before PGlite opens, exactly as `bootstrap.ts` does. B must
// hold the same notes and entities, and every vault file must hash the same.
// =============================================================================

const work = mkdtempSync(join(tmpdir(), 'kvox-backup-'));
const open: TestDatabase[] = [];

afterAll(async () => {
  for (const db of open) await db.close({ keepFolder: true });
  removeQuietly(work);
});

async function hashes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[relative(root, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(root)) await walk(root);
  return out;
}

/** The Copilot directory's three kinds of content. */
function writeCopilotFiles(root: string, secret: string): void {
  for (const [path, content] of [
    ['home/auth/token.json', secret],
    ['home/session-state/s1/events.jsonl', '{}'],
    ['runtime/1.0.98/installed.json', '{}'],
  ] as const) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function backupJobs(db: TestDatabase, onRestoreStaged: () => void = () => undefined): PgTableJobs {
  const jobs = new PgTableJobs(db.prisma, { dataDir: db.userDataDir, orgId: db.orgId, log: () => undefined });
  registerBackupJobs(jobs, {
    folder: dataFolder(db.userDataDir),
    appVersion: 'test',
    dumpDatabase: () => db.database.dump(),
    migrations: async () =>
      (await db.prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`SELECT migration_name AS name FROM _prisma_migrations ORDER BY 1`)).map((r) => r.name),
    knownMigrations: () => shippedMigrations(ROOT),
    onRestoreStaged,
    log: () => undefined,
  });
  return jobs;
}

async function runJob(jobs: PgTableJobs, type: string, path: string) {
  const { id } = await jobs.enqueue({ type, subjectType: BACKUP_SUBJECT, subjectId: randomBytes(8).toString('hex'), payload: { path } });
  await jobs.drain();
  return jobs.describeJob(id);
}

describe('backup and restore', () => {
  it('reproduces notes, graph and files on a fresh profile', async () => {
    // ---- Profile A ------------------------------------------------------------
    const a = await openTestDatabase(join(work, 'profile-a'));
    open.push(a);
    const folderA = dataFolder(a.userDataDir);
    const store = new LocalFsObjectStore({ prisma: a.prisma, vaultDir: folderA.vault, partsDir: folderA.uploadParts, orgId: a.orgId, baseUrl: () => '' });
    for (let i = 0; i < 3; i += 1) {
      await store.put({ ownerId: LOCAL_USER_ID, key: `notes/doc-${i}/${i}.bin`, body: randomBytes(50_000 + i), contentType: 'application/octet-stream', managedBy: 'notes' });
    }
    const notes = [
      await a.prisma.note.create({ data: { ownerId: LOCAL_USER_ID, title: 'Budget review', sourceType: 'document', body: 'Joe sends the budget by Friday.' } }),
      await a.prisma.note.create({ data: { ownerId: LOCAL_USER_ID, title: 'Planning', sourceType: 'document', body: 'Jenny reviews the plan.' } }),
    ];
    // An entity needs its evidence in the same transaction (the graph's no-orphans invariant).
    const entities = [
      { id: randomUUID(), label: 'Joe', quote: 'Joe sends the budget' },
      { id: randomUUID(), label: 'Jenny', quote: 'Jenny reviews the plan' },
    ];
    for (const [i, entity] of entities.entries()) {
      await a.prisma.$transaction([
        a.prisma.kgEntity.create({ data: { id: entity.id, ownerId: LOCAL_USER_ID, type: 'person', label: entity.label, ontologyVersion: '1' } }),
        a.prisma.kgEvidence.create({
          data: { ownerId: LOCAL_USER_ID, subjectKind: 'entity', subjectId: entity.id, noteId: notes[i].id, quote: entity.quote },
        }),
      ]);
    }
    const vaultA = await hashes(folderA.vault);
    expect(Object.keys(vaultA)).toHaveLength(3);
    // The Copilot runtime's private state (marinoscar/kvox-desktop#23): sign-in material, sessions and a downloaded runtime.
    const copilotSecret = `copilot-sign-in-${randomBytes(8).toString('hex')}`;
    writeCopilotFiles(folderA.copilot, copilotSecret);
    // The on-device embedding model (marinoscar/kvox#660) is re-downloadable and never archived either.
    const modelMarker = `local-model-${randomBytes(8).toString('hex')}`;
    mkdirSync(join(folderA.models, 'bge-small-en-v1.5-int8'), { recursive: true });
    writeFileSync(join(folderA.models, 'bge-small-en-v1.5-int8', 'model.onnx'), modelMarker);

    const archive = join(work, 'export', 'kvox.kvoxbackup');
    const exported = await runJob(backupJobs(a), BACKUP_EXPORT_JOB, archive);
    expect(exported).toMatchObject({ status: 'succeeded', lastError: null });
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(`${archive}.partial`)).toBe(false);
    // Nothing under copilot/ is in the archive: no entry, no file content (vault entries are stored uncompressed).
    const bytes = readFileSync(archive).toString('latin1');
    expect(bytes).not.toContain('copilot/');
    expect(bytes).not.toContain(copilotSecret);
    expect(bytes).not.toContain('models/');
    expect(bytes).not.toContain(modelMarker);
    await a.close({ keepFolder: true });
    open.pop();

    // ---- Profile B: fresh, restore as a job, then the next start applies it ----
    const b = await openTestDatabase(join(work, 'profile-b'));
    open.push(b);
    expect(await b.prisma.note.count()).toBe(0);
    const folderBeforeRestore = dataFolder(b.userDataDir);
    writeCopilotFiles(folderBeforeRestore.copilot, 'profile-b-own-copilot-state');
    mkdirSync(folderBeforeRestore.models, { recursive: true });
    writeFileSync(join(folderBeforeRestore.models, 'b-own.onnx'), 'profile-b-model');
    let restartRequested = 0;
    const restored = await runJob(backupJobs(b, () => (restartRequested += 1)), BACKUP_RESTORE_JOB, archive);
    expect(restored).toMatchObject({ status: 'succeeded' });
    expect(restartRequested).toBe(1);
    const folderB = dataFolder(b.userDataDir);
    expect(hasPendingRestore(folderB)).toBe(true);
    await b.close({ keepFolder: true });
    open.pop();

    const lines: string[] = [];
    expect(await applyPendingRestore(folderB, PGLITE_EXTENSIONS, (line) => lines.push(line))).toBe(true);
    const b2 = await openTestDatabase(folderB.root);
    open.push(b2);
    await discardPreviousData(folderB);

    const restoredNotes = await b2.prisma.note.findMany({ orderBy: { title: 'asc' }, select: { id: true, title: true, body: true } });
    expect(restoredNotes).toEqual(notes.map((n) => ({ id: n.id, title: n.title, body: n.body })).sort((x, y) => x.title.localeCompare(y.title)));
    const restoredEntities = await b2.prisma.kgEntity.findMany({ orderBy: { label: 'asc' }, select: { id: true, label: true } });
    expect(restoredEntities).toEqual(entities.map((e) => ({ id: e.id, label: e.label })).sort((x, y) => x.label.localeCompare(y.label)));
    expect(await b2.prisma.kgEvidence.count()).toBe(2);
    expect(await b2.prisma.storageObject.count()).toBe(3);
    expect(await hashes(folderB.vault)).toEqual(vaultA);
    expect(existsSync(folderB.restorePending)).toBe(false);
    expect(existsSync(folderB.restorePrevious)).toBe(false);
    // A restore replaces db/ and vault/ only: this machine's Copilot state is neither overwritten nor removed,
    // and profile A's never arrived.
    expect(readFileSync(join(folderB.copilot, 'home', 'auth', 'token.json'), 'utf8')).toBe('profile-b-own-copilot-state');
    expect(existsSync(join(folderB.copilot, 'runtime', '1.0.98', 'installed.json'))).toBe(true);
    expect(readFileSync(join(folderB.copilot, 'home', 'auth', 'token.json'), 'utf8')).not.toContain(copilotSecret);
    // Likewise the models folder: B keeps its own, A's never arrived.
    expect(readFileSync(join(folderB.models, 'b-own.onnx'), 'utf8')).toBe('profile-b-model');
    expect(existsSync(join(folderB.models, 'bge-small-en-v1.5-int8'))).toBe(false);
  });

  it('refuses an archive with an entry outside its folder, a bad checksum or a newer database', async () => {
    const folder = dataFolder(join(work, 'profile-c'));
    const known = await shippedMigrations(ROOT);
    expect(known.length).toBeGreaterThan(0);
    const dump = Buffer.from('not really a dump');
    const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    // yazl refuses a `..` name, so a hostile one is patched into the bytes afterwards (same length).
    const write = async (name: string, entries: Array<[string, Buffer]>, patch?: [string, string]) => {
      const zip = new yazl.ZipFile();
      for (const [entry, data] of entries) zip.addBuffer(data, entry);
      zip.end();
      const path = join(work, name);
      await pipeline(zip.outputStream, createWriteStream(path));
      if (patch) writeFileSync(path, Buffer.from(readFileSync(path).toString('latin1').split(patch[0]).join(patch[1]), 'latin1'));
      return path;
    };
    const manifest = (files: object[], migrations = known) =>
      Buffer.from(JSON.stringify({ format: 'kvoxbackup', formatVersion: 1, createdAt: '', app: { name: '', version: '' }, migrations, files }));

    const traversal = await write(
      'traversal.kvoxbackup',
      [
        ['vault/XX/XX/evil.txt', Buffer.from('x')],
        ['manifest.json', manifest([])],
      ],
      ['vault/XX/XX/evil.txt', 'vault/../../evil.txt'],
    );
    await expect(stageRestore(folder, traversal, known)).rejects.toThrow(BackupInvalidError);

    const tampered = await write('tampered.kvoxbackup', [
      ['db.tar.gz', dump],
      ['manifest.json', manifest([{ path: 'db.tar.gz', size: dump.length, sha256: sha(Buffer.from('other')) }])],
    ]);
    await expect(stageRestore(folder, tampered, known)).rejects.toThrow(/checksum/);

    const newer = await write('newer.kvoxbackup', [
      ['db.tar.gz', dump],
      ['manifest.json', manifest([{ path: 'db.tar.gz', size: dump.length, sha256: sha(dump) }], [...known, '99999999999999_from_the_future'])],
    ]);
    await expect(stageRestore(folder, newer, known)).rejects.toThrow(/newer KVox Desktop/);

    // An archive that carries the Copilot directory is not one this app wrote: refused, nothing staged.
    const withCopilot = await write('with-copilot.kvoxbackup', [
      ['db.tar.gz', dump],
      ['copilot/home/auth/token.json', Buffer.from('{}')],
      ['manifest.json', manifest([{ path: 'db.tar.gz', size: dump.length, sha256: sha(dump) }])],
    ]);
    await expect(stageRestore(folder, withCopilot, known)).rejects.toThrow(/unexpected entry "copilot\/home\/auth\/token.json"/);
    expect(existsSync(folder.copilot)).toBe(false);

    await expect(stageRestore(folder, join(work, 'missing.kvoxbackup'), known)).rejects.toThrow(/does not exist/);
    expect(hasPendingRestore(folder)).toBe(false);
    expect(existsSync(folder.restoreStaging)).toBe(false);
  });
});
