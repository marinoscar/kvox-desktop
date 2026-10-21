import { join } from 'node:path';

// =============================================================================
// The user data folder of KVox Desktop (marinoscar/kvox#583, ADR-0004)
// =============================================================================
//
// Everything the app keeps lives under `app.getPath('userData')`, and nowhere
// else:
//
//   db/              PGlite's data directory (notes, transcripts, the graph,
//                    jobs, settings: every table)
//   vault/<key>      the bytes of every stored object (KVOX_OBJECT_STORE)
//   logs/audit.log   the append-only audit trail (KVOX_AUDIT; ids and counts)
//   secrets.bin      provider keys, each one a `safeStorage` blob (KVOX_SECRETS)
//   settings.json    the shell's own preferences (written by the main process)
//   tmp/             scratch files and upload parts; emptied at every start
//   copilot/         the GitHub Copilot runtime's private state (marinoscar/kvox-desktop#23):
//                    home/ (COPILOT_HOME: sessions and sign-in material), work/ (an empty
//                    working directory), runtime/<version>/ (the downloaded runtime).
//                    NEVER in a backup or a data export, never touched by a restore
//
// Transient, during a restore only: `restore-staging/` (an archive being
// checked), `restore-pending/` (checked, applied at the next server start) and
// `restore-previous/` (what the restore replaced, removed once the restored
// database has opened).
// =============================================================================

/** The paths of the user data folder. */
export interface DataFolder {
  readonly root: string;
  readonly db: string;
  readonly vault: string;
  readonly logs: string;
  readonly auditLog: string;
  readonly secrets: string;
  readonly settings: string;
  readonly tmp: string;
  /** The Copilot runtime's private directory. Excluded from backups and exports. */
  readonly copilot: string;
  /** The on-device embedding model's folder. Excluded from backups and exports. */
  readonly models: string;
  readonly uploadParts: string;
  readonly restoreStaging: string;
  readonly restorePending: string;
  readonly restorePrevious: string;
}

/** The layout under one user data folder. */
export function dataFolder(root: string): DataFolder {
  return {
    root,
    db: join(root, 'db'),
    vault: join(root, 'vault'),
    logs: join(root, 'logs'),
    auditLog: join(root, 'logs', 'audit.log'),
    secrets: join(root, 'secrets.bin'),
    settings: join(root, 'settings.json'),
    tmp: join(root, 'tmp'),
    copilot: join(root, 'copilot'),
    models: join(root, 'models'),
    uploadParts: join(root, 'tmp', 'parts'),
    restoreStaging: join(root, 'restore-staging'),
    restorePending: join(root, 'restore-pending'),
    restorePrevious: join(root, 'restore-previous'),
  };
}
