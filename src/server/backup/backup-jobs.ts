import type { KvoxJobsPort } from '@marinoscar/kvox-api/ports';

import type { DataFolder } from '../data-folder.js';
import { stageRestore, writeBackup, type BackupSource } from './backup.js';

// =============================================================================
// Export and restore run as jobs (marinoscar/kvox#583; kvox AGENTS.md rule 1)
// =============================================================================
//
// Long work never runs in a request: the route enqueues, the card polls the
// job. Both handlers run on the KVOX_JOBS runner like any slice's job (one at a
// time, a row in `jobs`, recovered after a crash). One attempt each: a failed
// export or a refused archive is reported, not retried behind the user's back.
//
// A restore job only STAGES (see `backup.ts`); when it succeeds the host asks
// the main process to restart the server, which applies it before PGlite opens.
// =============================================================================

export const BACKUP_EXPORT_JOB = 'desktop.backup.export';
export const BACKUP_RESTORE_JOB = 'desktop.backup.restore';
/** The `subjectType` of both jobs; the subject id is the operation id the route hands out. */
export const BACKUP_SUBJECT = 'desktop.backup';

const PROFILE = { maxRuntimeMs: 60 * 60 * 1000, maxAttempts: 1 };

/** What the backup handlers need. */
export interface BackupJobsDeps extends BackupSource {
  folder: DataFolder;
  /** The migration names this app ships. */
  knownMigrations(): Promise<string[]>;
  /** Called once a restore is staged: restart the server to apply it. */
  onRestoreStaged(): void;
  log: (line: string) => void;
}

function pathOf(payload: unknown): string {
  const path = (payload as { path?: unknown } | null)?.path;
  if (typeof path !== 'string' || path === '') throw new Error('The job has no path');
  return path;
}

/** Registers the export and restore handlers. */
export function registerBackupJobs(jobs: KvoxJobsPort, deps: BackupJobsDeps): void {
  jobs.registerHandler({
    type: BACKUP_EXPORT_JOB,
    label: 'Export data',
    profile: PROFILE,
    async process(job) {
      const manifest = await writeBackup(deps, pathOf(job.payload));
      deps.log(`backup: exported ${manifest.files.length} file(s)`);
    },
  });
  jobs.registerHandler({
    type: BACKUP_RESTORE_JOB,
    label: 'Restore data',
    profile: PROFILE,
    async process(job) {
      const manifest = await stageRestore(deps.folder, pathOf(job.payload), await deps.knownMigrations());
      deps.log(`backup: restore of ${manifest.files.length} file(s) staged; restarting the server`);
    },
  });
  jobs.onSettled((event) => {
    if (event.type === BACKUP_RESTORE_JOB && event.status === 'succeeded') deps.onRestoreStaged();
  });
}
