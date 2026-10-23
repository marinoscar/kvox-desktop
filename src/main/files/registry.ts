import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';

import type { FilesFolderRef } from '../../shared/protocol';
import { SETTINGS_ID_PATTERN, readShellSettings, writeShellSettings, type FilesSettings } from '../shell-settings';
import { FilesError } from './paths';

// =============================================================================
// The folders this device remembers (marinoscar/kvox-desktop#47)
// =============================================================================
//
// `settings.json` (`files`): folder id (a random UUID) -> absolute path and
// name, and library id -> folder id. The binding is per DEVICE, as the port's
// contract says: the same library may live elsewhere on another machine, so it
// is never sent to the server, and `settings.json` is not part of a backup.
// The renderer only ever sees `{ id, name }`.
// =============================================================================

/** True for an id the renderer may send (a folder's or a library's). */
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && SETTINGS_ID_PATTERN.test(value);
}

/** The folder registry over the shell settings file. */
export class FolderRegistry {
  private readonly settingsPath: () => string;

  /** `settingsPath`: `<userData>/settings.json`, or a function answering it (read at each call). */
  constructor(
    settingsPath: string | (() => string),
    private readonly createId: () => string = randomUUID,
  ) {
    this.settingsPath = typeof settingsPath === 'string' ? () => settingsPath : settingsPath;
  }

  private read(): FilesSettings {
    return readShellSettings(this.settingsPath()).files;
  }

  private write(update: (files: FilesSettings) => void): void {
    const settings = readShellSettings(this.settingsPath());
    update(settings.files);
    writeShellSettings(this.settingsPath(), settings);
  }

  /** Every remembered folder, as the renderer may see it. */
  list(): FilesFolderRef[] {
    return Object.entries(this.read().folders).map(([id, folder]) => ({ id, name: folder.name }));
  }

  /** The absolute path of a folder id, or `unknown_folder`. */
  rootOf(folderId: unknown): string {
    if (!isValidId(folderId)) throw new FilesError('unknown_folder', 'Unknown folder.');
    const folder = this.read().folders[folderId];
    if (!folder) throw new FilesError('unknown_folder', 'Unknown folder; it may have been forgotten.');
    return folder.path;
  }

  /** Remembers `absolutePath`; a folder already known answers its existing ref (its bindings hold). */
  add(absolutePath: string): FilesFolderRef {
    const path = resolve(absolutePath);
    const known = Object.entries(this.read().folders).find(([, folder]) => folder.path === path);
    if (known) return { id: known[0], name: known[1].name };
    const ref: FilesFolderRef = { id: this.createId(), name: basename(path) || path };
    this.write((files) => {
      files.folders[ref.id] = { path, name: ref.name };
    });
    return ref;
  }

  /** Forgets a folder and every library bound to it. */
  forget(folderId: unknown): void {
    if (!isValidId(folderId)) throw new FilesError('unknown_folder', 'Unknown folder.');
    this.write((files) => {
      delete files.folders[folderId];
      for (const [libraryId, boundId] of Object.entries(files.libraries)) {
        if (boundId === folderId) delete files.libraries[libraryId];
      }
    });
  }

  /** The folder a library is bound to, or `null`. */
  libraryFolder(libraryId: unknown): FilesFolderRef | null {
    if (!isValidId(libraryId)) throw new FilesError('not_found', 'Not a library id.');
    const files = this.read();
    const folderId = files.libraries[libraryId];
    const folder = folderId === undefined ? undefined : files.folders[folderId];
    return folderId !== undefined && folder ? { id: folderId, name: folder.name } : null;
  }

  /** Binds a library to a known folder; `null` unbinds it. */
  bindLibrary(libraryId: unknown, folderId: unknown): void {
    if (!isValidId(libraryId)) throw new FilesError('not_found', 'Not a library id.');
    if (folderId !== null) this.rootOf(folderId);
    this.write((files) => {
      if (folderId === null) delete files.libraries[libraryId];
      else files.libraries[libraryId] = folderId as string;
    });
  }
}
