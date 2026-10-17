import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// =============================================================================
// The shell's own preferences: `<userData>/settings.json` (marinoscar/kvox#583)
// =============================================================================
//
// What the main process decides before (or without) the server: today, the
// user's consent to store saved keys with Linux's `basic_text` backend. The
// KVOX_SETTINGS namespaces are not here; they live in the database. Written
// whole through a temporary file and a rename.
// =============================================================================

export interface ShellSettings {
  secrets: { allowPlaintext: boolean };
}

const DEFAULTS: ShellSettings = { secrets: { allowPlaintext: false } };

export function readShellSettings(path: string): ShellSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShellSettings>;
    return { secrets: { allowPlaintext: parsed.secrets?.allowPlaintext === true } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeShellSettings(path: string, settings: ShellSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
