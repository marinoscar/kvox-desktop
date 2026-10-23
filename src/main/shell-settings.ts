import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { parseThemeMode, type ThemeMode } from '../shared/protocol';

// =============================================================================
// The shell's own preferences: `<userData>/settings.json` (marinoscar/kvox#583)
// =============================================================================
//
// What the main process decides before (or without) the server: the user's
// consent to store saved keys with Linux's `basic_text` backend, whether
// KVox checks for updates (off unless the user turns it on: ADR-0004) and the
// theme choice (the renderer owns it in localStorage; main keeps a copy so the
// window is painted in the right colour before any page exists) and the shell's
// rail preference (collapsed or expanded, marinoscar/kvox-desktop#18), and the
// folders the user picked for note libraries with the library -> folder
// bindings (marinoscar/kvox-desktop#47: per device, never in a backup). The
// KVOX_SETTINGS namespaces are not here; they live in the database. Written
// whole through a temporary file and a rename.
// =============================================================================

/** One folder the user picked (`files:pick-folder`): the absolute path stays in the main process. */
export interface SavedFolder {
  /** The absolute path on this device. */
  path: string;
  /** The display name (the last path segment). */
  name: string;
}

/** The file-access port's state (src/main/files). */
export interface FilesSettings {
  /** Folder id (a random UUID) -> the folder. */
  folders: Record<string, SavedFolder>;
  /** Library id -> folder id. */
  libraries: Record<string, string>;
}

/** What an id read from the file (a folder's or a library's) may look like. */
export const SETTINGS_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export interface ShellSettings {
  secrets: { allowPlaintext: boolean };
  updates: { checkForUpdates: boolean };
  /** Light, dark, or `system` (the default). */
  themeMode: ThemeMode;
  /** The shell's own preferences, the `ShellPreferencesPort` of the renderer (marinoscar/kvox-desktop#18). */
  shell: { railCollapsed: boolean };
  /** The note-library folders and their bindings (marinoscar/kvox-desktop#47). */
  files: FilesSettings;
}

const DEFAULTS: ShellSettings = {
  secrets: { allowPlaintext: false },
  updates: { checkForUpdates: false },
  themeMode: 'system',
  shell: { railCollapsed: false },
  files: { folders: {}, libraries: {} },
};

/** The `files` section, keeping only well-formed entries (a damaged one is dropped, never guessed at). */
function readFilesSettings(value: unknown): FilesSettings {
  const files: FilesSettings = { folders: {}, libraries: {} };
  const raw = (value ?? {}) as { folders?: unknown; libraries?: unknown };
  if (raw.folders && typeof raw.folders === 'object') {
    for (const [id, folder] of Object.entries(raw.folders as Record<string, unknown>)) {
      const { path, name } = (folder ?? {}) as { path?: unknown; name?: unknown };
      if (!SETTINGS_ID_PATTERN.test(id) || typeof path !== 'string' || !isAbsolute(path) || typeof name !== 'string') continue;
      files.folders[id] = { path, name };
    }
  }
  if (raw.libraries && typeof raw.libraries === 'object') {
    for (const [libraryId, folderId] of Object.entries(raw.libraries as Record<string, unknown>)) {
      if (!SETTINGS_ID_PATTERN.test(libraryId) || typeof folderId !== 'string' || !Object.hasOwn(files.folders, folderId)) continue;
      files.libraries[libraryId] = folderId;
    }
  }
  return files;
}

export function readShellSettings(path: string): ShellSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShellSettings>;
    return {
      secrets: { allowPlaintext: parsed.secrets?.allowPlaintext === true },
      // Only an explicit `true` turns updates on: a missing or damaged file means off.
      updates: { checkForUpdates: parsed.updates?.checkForUpdates === true },
      // Anything but a known mode (a missing or damaged value) is `system`.
      themeMode: parseThemeMode(parsed.themeMode) ?? 'system',
      // Only an explicit `true` collapses the rail: a missing or damaged value is expanded.
      shell: { railCollapsed: parsed.shell?.railCollapsed === true },
      files: readFilesSettings(parsed.files),
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeShellSettings(path: string, settings: ShellSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
