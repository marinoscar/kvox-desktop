import { watch as fsWatch, type FSWatcher } from 'node:fs';

import { normalizeLibraryPath } from '@marinoscar/kvox-contract/notes';

import { isSkippedName } from './walk';

// =============================================================================
// Watching picked folders (marinoscar/kvox-desktop#47)
// =============================================================================
//
// One `fs.watch(root, { recursive: true })` per watched folder (recursive is
// native on macOS and Windows, and on Linux since Node 20). Events are bursty
// (an editor's save is several), so the changed paths are collected and sent
// once the folder has been quiet for `debounceMs` (2 s). Paths are relative and
// POSIX (`normalizeLibraryPath`); hidden entries and `node_modules` are
// dropped, as the walk drops them. A watcher that fails (the folder was
// removed) is closed and reported as one change with no paths, so the caller
// syncs and the scan tells the server what is missing.
// =============================================================================

/** What the watcher needs of `fs.watch`, injectable for a test. */
export type WatchFunction = (
  path: string,
  options: { recursive: boolean; persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => Pick<FSWatcher, 'close' | 'on'>;

export interface FolderWatchersOptions {
  /** Called once per quiet period with the folder id and the paths that changed. */
  onChange: (folderId: string, paths: string[]) => void;
  log?: (line: string) => void;
  /** Default 2000 ms. */
  debounceMs?: number;
  /** Default `fs.watch`. */
  watch?: WatchFunction;
}

interface Watched {
  watcher: Pick<FSWatcher, 'close' | 'on'>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The set of watched folders. */
export class FolderWatchers {
  private readonly watched = new Map<string, Watched>();
  private readonly debounceMs: number;
  private readonly watchFn: WatchFunction;

  constructor(private readonly options: FolderWatchersOptions) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.watchFn = options.watch ?? ((path, watchOptions, listener) => fsWatch(path, watchOptions, listener));
  }

  /** Starts watching `root` as `folderId`; a second call for the same id is a no-op. */
  watch(folderId: string, root: string): void {
    if (this.watched.has(folderId)) return;
    const entry: Watched = {
      watcher: this.watchFn(root, { recursive: true, persistent: false }, (_event, filename) => this.record(folderId, filename)),
      pending: new Set(),
      timer: null,
    };
    entry.watcher.on('error', () => {
      this.options.log?.('files: a folder watcher stopped (the folder may have been moved or removed)');
      this.flushNow(folderId);
      this.unwatch(folderId);
    });
    this.watched.set(folderId, entry);
  }

  /** Stops watching `folderId` (a pending change is dropped). */
  unwatch(folderId: string): void {
    const entry = this.watched.get(folderId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.watched.delete(folderId);
    try {
      entry.watcher.close();
    } catch {
      // Already closed.
    }
  }

  /** The folder ids being watched. */
  ids(): string[] {
    return [...this.watched.keys()];
  }

  /** Stops every watcher. */
  closeAll(): void {
    for (const id of this.ids()) this.unwatch(id);
  }

  private record(folderId: string, filename: string | Buffer | null): void {
    const entry = this.watched.get(folderId);
    if (!entry) return;
    const raw = filename === null ? null : filename.toString();
    const path = raw === null ? null : normalizeLibraryPath(raw);
    // A rename of the folder itself, or an event without a name, still means "look again".
    if (path !== null && path.split('/').some(isSkippedName)) return;
    if (path !== null) entry.pending.add(path);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flushNow(folderId), this.debounceMs);
  }

  private flushNow(folderId: string): void {
    const entry = this.watched.get(folderId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    const paths = [...entry.pending];
    entry.pending.clear();
    this.options.onChange(folderId, paths);
  }
}
