import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
// rail preference (collapsed or expanded, marinoscar/kvox-desktop#18). The
// KVOX_SETTINGS namespaces are not here; they live in the database. Written
// whole through a temporary file and a rename.
// =============================================================================

export interface ShellSettings {
  secrets: { allowPlaintext: boolean };
  updates: { checkForUpdates: boolean };
  /** Light, dark, or `system` (the default). */
  themeMode: ThemeMode;
  /** The shell's own preferences, the `ShellPreferencesPort` of the renderer (marinoscar/kvox-desktop#18). */
  shell: { railCollapsed: boolean };
}

const DEFAULTS: ShellSettings = { secrets: { allowPlaintext: false }, updates: { checkForUpdates: false }, themeMode: 'system', shell: { railCollapsed: false } };

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
