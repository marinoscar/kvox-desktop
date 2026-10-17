// =============================================================================
// Messages between the main process and the server utility process
// =============================================================================
//
// The token travels in a message, never in the environment: the server's child
// processes (the migration commands) inherit its environment.
//
// Four services only the main process can offer travel here too: `safeStorage`
// (the server asks, main answers by `id`), OS notifications, a restart of the
// server (after a restore was staged) and a utility process for a migration
// command (`run-node`, answered by `id`; the RunAsNode fuse is off).
// =============================================================================

/** The `safeStorage` operations the server asks the main process for. */
export type SecretOp = { op: 'status' } | { op: 'encrypt'; value: string } | { op: 'decrypt'; value: string };

/** Main -> server. */
export type ToServer =
  | {
      type: 'start';
      appRoot: string;
      userDataDir: string;
      token: string;
      allowedOrigins: string[];
      appVersion: string;
    }
  | { type: 'stop' }
  | { type: 'secrets-result'; id: number; ok: true; value: unknown }
  | { type: 'secrets-result'; id: number; ok: false; error: string }
  | { type: 'run-node-result'; id: number; code: number | null; output: string };

/** Server -> main. */
export type FromServer =
  | { type: 'ready'; port: number; userId: string; permissions: string[]; timings: Record<string, number> }
  | { type: 'error'; message: string }
  | { type: 'log'; line: string; level?: 'info' | 'error' }
  | { type: 'stopped' }
  | ({ type: 'secrets'; id: number } & SecretOp)
  | { type: 'notify'; title: string; body: string }
  | { type: 'restart'; reason: string }
  | { type: 'run-node'; id: number; script: string; args: string[]; cwd: string; env: Record<string, string> };

/** What the preload hands the renderer. */
export interface DesktopConnection {
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** The per-launch token. */
  token: string;
  userId: string;
  permissions: string[];
}

/** How saved keys are protected (Electron `safeStorage`), as the settings card shows it. */
export interface SecretStorageStatus {
  /** `safeStorage.isEncryptionAvailable()`. */
  available: boolean;
  /** `safeStorage.getSelectedStorageBackend()` on Linux (`basic_text` means no keyring); `null` elsewhere. */
  backend: string | null;
  /** The user accepted storing keys with `basic_text` (kept in `settings.json`). */
  plaintextAccepted: boolean;
}

/** Opt-in updates, as the settings card shows them (marinoscar/kvox#587). */
export interface UpdateStatus {
  /** The user turned on "Check for updates". */
  enabled: boolean;
  state: 'off' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  /** The running version. */
  currentVersion: string;
  /** The newer version being downloaded or ready to install. */
  version?: string;
  /** The first line of the last error. */
  message?: string;
}

/**
 * What one file import produced (marinoscar/kvox#585): a note (a KVox note export), a
 * transcript (a transcript JSON export) or a note source document (PDF, Markdown,
 * text), or the server's refusal in words a person can read.
 */
export type ImportOutcome =
  | { ok: true; kind: 'note' | 'transcript' | 'document'; id: string; title: string; filename: string }
  | { ok: false; filename: string; message: string; reason?: string; status?: number };

/** The renderer's door to the shell (`window.kvoxDesktop`, set by the preload). */
export interface KvoxDesktopBridge {
  connection(): Promise<DesktopConnection>;
  /** The user data folder, for the settings card. */
  dataFolder(): Promise<string>;
  /** A save dialog for a `.kvoxbackup`; `null` when cancelled. */
  chooseBackupTarget(): Promise<string | null>;
  /** An open dialog for a `.kvoxbackup`; `null` when cancelled. */
  chooseBackupSource(): Promise<string | null>;
  secretStorage(): Promise<SecretStorageStatus>;
  /** Records (or withdraws) the consent to store keys with `basic_text`. */
  acceptPlaintextSecrets(accepted: boolean): Promise<SecretStorageStatus>;
  updates(): Promise<UpdateStatus>;
  /** Turns "Check for updates" on or off (persisted; applied at once). */
  setUpdatesEnabled(enabled: boolean): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<void>;
  /** The native open dialog, then each chosen file imported; `null` when cancelled. */
  importFromDialog(): Promise<ImportOutcome[] | null>;
  /** Imports files dropped on the window (their paths are read in the preload). */
  importDropped(files: readonly File[]): Promise<ImportOutcome[]>;
}
