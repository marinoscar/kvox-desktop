import { randomUUID } from 'node:crypto';

import { dialog, ipcMain, type BrowserWindow } from 'electron';

import {
  FILES_CHANNELS,
  FILES_ENUMERATE_PAGE_SIZE,
  type FilesChangedEvent,
  type FilesEntry,
  type FilesEnumeratePage,
  type FilesResult,
} from '../../shared/protocol';
import { FilesError } from './paths';
import { FolderRegistry } from './registry';
import { extensionSet, hashFile, readFileInside, walkFolder } from './walk';
import { FolderWatchers, type WatchFunction } from './watcher';

// =============================================================================
// The file-access port's IPC handlers (marinoscar/kvox-desktop#47)
// =============================================================================
//
// The main-process half of `KvoxFileAccessPort` (`@marinoscar/kvox-web/core/
// headless`). Every handler validates what the page sends (a folder id must be
// one this device remembers, a path must resolve inside it) and answers a
// `FilesResult`, so the code of an expected failure survives IPC. A walk is
// paged (`FILES_ENUMERATE_PAGE_SIZE` entries per call) so a folder of tens of
// thousands of files is never one giant message. Logs carry counts and codes,
// never a path or a file name.
// =============================================================================

/** An open walk, read page by page. Released when done, cancelled or idle for a minute. */
interface Walk {
  iterator: AsyncGenerator<FilesEntry>;
  timer: ReturnType<typeof setTimeout>;
}

const WALK_IDLE_MS = 60_000;

/** The handlers' logic, apart from Electron's `ipcMain` (what the unit tests drive). */
export class FilesService {
  readonly registry: FolderRegistry;
  readonly watchers: FolderWatchers;
  private readonly walks = new Map<string, Walk>();

  constructor(options: {
    settingsPath: string | (() => string);
    onChange: (event: FilesChangedEvent) => void;
    log?: (line: string) => void;
    watch?: WatchFunction;
    debounceMs?: number;
    createId?: () => string;
  }) {
    this.registry = new FolderRegistry(options.settingsPath, options.createId);
    this.watchers = new FolderWatchers({
      onChange: (folderId, paths) => options.onChange({ folderId, paths }),
      ...(options.log ? { log: options.log } : {}),
      ...(options.watch ? { watch: options.watch } : {}),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    });
  }

  /** Starts a walk of a known folder. */
  enumerate(folderId: unknown, extensions: unknown): { cursor: string } {
    const root = this.registry.rootOf(folderId);
    if (!Array.isArray(extensions) || extensions.length === 0 || extensions.length > 50) {
      throw new FilesError('not_found', 'No extensions to look for.');
    }
    const cursor = randomUUID();
    const iterator = walkFolder(root, extensionSet(extensions as string[]));
    this.walks.set(cursor, { iterator, timer: this.idleTimer(cursor) });
    return { cursor };
  }

  /** The next page of a walk. */
  async enumerateNext(cursor: unknown): Promise<FilesEnumeratePage> {
    const walk = typeof cursor === 'string' ? this.walks.get(cursor) : undefined;
    if (!walk || typeof cursor !== 'string') throw new FilesError('unknown_folder', 'The folder walk has ended.');
    clearTimeout(walk.timer);
    const entries: FilesEntry[] = [];
    try {
      while (entries.length < FILES_ENUMERATE_PAGE_SIZE) {
        const next = await walk.iterator.next();
        if (next.done) {
          this.walks.delete(cursor);
          return { entries, done: true };
        }
        entries.push(next.value);
      }
    } catch (error) {
      this.walks.delete(cursor);
      throw error;
    }
    walk.timer = this.idleTimer(cursor);
    return { entries, done: false };
  }

  /** Ends a walk early. */
  async enumerateCancel(cursor: unknown): Promise<void> {
    const walk = typeof cursor === 'string' ? this.walks.get(cursor) : undefined;
    if (!walk || typeof cursor !== 'string') return;
    clearTimeout(walk.timer);
    this.walks.delete(cursor);
    await walk.iterator.return(undefined).catch(() => undefined);
  }

  hash(folderId: unknown, path: unknown): Promise<string> {
    return hashFile(this.registry.rootOf(folderId), path);
  }

  read(folderId: unknown, path: unknown): Promise<ArrayBuffer> {
    return readFileInside(this.registry.rootOf(folderId), path);
  }

  watch(folderId: unknown): void {
    const root = this.registry.rootOf(folderId);
    this.watchers.watch(folderId as string, root);
  }

  unwatch(folderId: unknown): void {
    if (typeof folderId === 'string') this.watchers.unwatch(folderId);
  }

  forget(folderId: unknown): void {
    this.unwatch(folderId);
    this.registry.forget(folderId);
  }

  /** Releases every walk and watcher. */
  close(): void {
    for (const cursor of [...this.walks.keys()]) void this.enumerateCancel(cursor);
    this.watchers.closeAll();
  }

  private idleTimer(cursor: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.enumerateCancel(cursor), WALK_IDLE_MS);
    timer.unref?.();
    return timer;
  }
}

/** Runs a handler and answers its result, or the code and sentence of an expected failure. */
export async function answer<T>(run: () => T | Promise<T>, log?: (line: string) => void): Promise<FilesResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof FilesError) return { ok: false, code: error.code, message: error.message };
    log?.(`files: failed: ${error instanceof Error ? error.name : 'error'}`);
    return { ok: false, code: 'not_found', message: 'The file or folder could not be read.' };
  }
}

/** Registers the `files:*` handlers; returns the service (closed at quit). */
export function registerFilesIpc(options: {
  window: () => BrowserWindow | undefined;
  settingsPath: () => string;
  log: (line: string) => void;
}): FilesService {
  const { log } = options;
  const service = new FilesService({
    settingsPath: options.settingsPath,
    log,
    onChange: (event) => {
      const window = options.window();
      if (window && !window.isDestroyed()) window.webContents.send(FILES_CHANNELS.changed, event);
    },
  });

  ipcMain.handle(FILES_CHANNELS.pickFolder, () =>
    answer(async () => {
      const window = options.window();
      const dialogOptions = { title: 'Choose a folder of notes', properties: ['openDirectory' as const] };
      const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      const path = result.canceled ? undefined : result.filePaths[0];
      return path ? service.registry.add(path) : null;
    }, log),
  );
  ipcMain.handle(FILES_CHANNELS.listFolders, () => answer(() => service.registry.list(), log));
  ipcMain.handle(FILES_CHANNELS.forgetFolder, (_event, folderId: unknown) => answer(() => (service.forget(folderId), null), log));
  ipcMain.handle(FILES_CHANNELS.enumerate, (_event, folderId: unknown, extensions: unknown) =>
    answer(() => service.enumerate(folderId, extensions), log),
  );
  ipcMain.handle(FILES_CHANNELS.enumerateNext, (_event, cursor: unknown) => answer(() => service.enumerateNext(cursor), log));
  ipcMain.handle(FILES_CHANNELS.enumerateCancel, (_event, cursor: unknown) => service.enumerateCancel(cursor));
  ipcMain.handle(FILES_CHANNELS.hash, (_event, folderId: unknown, path: unknown) => answer(() => service.hash(folderId, path), log));
  ipcMain.handle(FILES_CHANNELS.read, (_event, folderId: unknown, path: unknown) => answer(() => service.read(folderId, path), log));
  ipcMain.handle(FILES_CHANNELS.getLibraryFolder, (_event, libraryId: unknown) =>
    answer(() => service.registry.libraryFolder(libraryId), log),
  );
  ipcMain.handle(FILES_CHANNELS.setLibraryFolder, (_event, libraryId: unknown, folderId: unknown) =>
    answer(() => (service.registry.bindLibrary(libraryId, folderId), null), log),
  );
  ipcMain.handle(FILES_CHANNELS.watch, (_event, folderId: unknown) => answer(() => (service.watch(folderId), null), log));
  ipcMain.handle(FILES_CHANNELS.unwatch, (_event, folderId: unknown) => service.unwatch(folderId));
  return service;
}
