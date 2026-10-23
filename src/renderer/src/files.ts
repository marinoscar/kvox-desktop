import { KvoxFileAccessError } from '@marinoscar/kvox-web/core/headless';
import type {
  KvoxEnumerateOptions,
  KvoxFileAccessCapabilities,
  KvoxFileAccessPort,
  KvoxFileEntry,
  KvoxFolderRef,
} from '@marinoscar/kvox-web/core/headless';

import type { FilesResult, KvoxDesktopFilesBridge } from '../../shared/protocol';

// =============================================================================
// KvoxFileAccessPort over the preload bridge (marinoscar/kvox-desktop#47)
// =============================================================================
//
// The port kvox-web's library pages and `runLibrarySync` read folders through
// (`KvoxWebHost.files`). Every call goes to the main process (`src/main/files/`),
// which owns the real paths: here a folder is only `{ id, name }` and a path is
// relative to it. Nothing here decides what to import; the packages do.
//
//   persistentFolders  the folders and bindings live in `<userData>/settings.json`
//   watch              `fs.watch` in main, debounced there; fanned out here
//   hashInHost         SHA-256 streamed in main, off the page's thread
// =============================================================================

const CAPABILITIES: KvoxFileAccessCapabilities = { persistentFolders: true, watch: true, hashInHost: true };

/** The port, plus a notice when a library is bound or unbound (the sync controller listens). */
export interface DesktopFileAccess extends KvoxFileAccessPort {
  /** Called after `setLibraryFolder` or `forgetFolder` changed the bindings; returns the unsubscribe. */
  onBindingsChanged(listener: () => void): () => void;
}

/** The value of a result, or the port's error (`too_large` is a plain error with the main process's sentence). */
function unwrap<T>(result: FilesResult<T>): T {
  if (result.ok) return result.value;
  if (result.code === 'too_large') throw new Error(result.message);
  throw new KvoxFileAccessError(result.code, result.message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Creates the Desktop file port over `bridge` (`window.kvoxDesktop.files`). */
export function createDesktopFileAccess(bridge: KvoxDesktopFilesBridge): DesktopFileAccess {
  const listeners = new Map<string, Set<(paths: string[]) => void>>();
  const bindingListeners = new Set<() => void>();
  let unsubscribeChanged: (() => void) | null = null;

  const bindingsChanged = () => {
    for (const listener of [...bindingListeners]) listener();
  };

  const ensureChangedSubscription = () => {
    unsubscribeChanged ??= bridge.onChanged((event) => {
      for (const listener of [...(listeners.get(event.folderId) ?? [])]) listener([...event.paths]);
    });
  };

  return {
    capabilities: CAPABILITIES,
    async pickFolder() {
      return unwrap(await bridge.pickFolder());
    },
    async listFolders() {
      return unwrap(await bridge.listFolders());
    },
    async forgetFolder(ref) {
      unwrap(await bridge.forgetFolder(ref.id));
      listeners.delete(ref.id);
      bindingsChanged();
    },
    enumerate(ref: KvoxFolderRef, options: KvoxEnumerateOptions): AsyncIterable<KvoxFileEntry> {
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(options.signal);
          const { cursor } = unwrap(await bridge.enumerate(ref.id, options.extensions));
          let finished = false;
          try {
            for (;;) {
              throwIfAborted(options.signal);
              const page = unwrap(await bridge.enumerateNext(cursor));
              for (const entry of page.entries) {
                throwIfAborted(options.signal);
                yield { path: entry.path, size: entry.size, mtime: entry.mtime };
              }
              if (page.done) {
                finished = true;
                return;
              }
            }
          } finally {
            // Aborted, broken out of, or failed: release the walk in main.
            if (!finished) await bridge.enumerateCancel(cursor).catch(() => undefined);
          }
        },
      };
    },
    async hash(ref, path, signal) {
      throwIfAborted(signal);
      const hex = unwrap(await bridge.hash(ref.id, path));
      throwIfAborted(signal);
      return hex;
    },
    async read(ref, path) {
      return new Blob([unwrap(await bridge.read(ref.id, path))]);
    },
    watch(ref, onChange) {
      ensureChangedSubscription();
      let set = listeners.get(ref.id);
      if (!set) {
        set = new Set();
        listeners.set(ref.id, set);
        void bridge.watch(ref.id).catch(() => undefined);
      }
      set.add(onChange);
      return () => {
        const current = listeners.get(ref.id);
        if (!current?.delete(onChange) || current.size > 0) return;
        listeners.delete(ref.id);
        void bridge.unwatch(ref.id).catch(() => undefined);
      };
    },
    async getLibraryFolder(libraryId) {
      return unwrap(await bridge.getLibraryFolder(libraryId));
    },
    async setLibraryFolder(libraryId, ref) {
      unwrap(await bridge.setLibraryFolder(libraryId, ref === null ? null : ref.id));
      bindingsChanged();
    },
    onBindingsChanged(listener) {
      bindingListeners.add(listener);
      return () => {
        bindingListeners.delete(listener);
      };
    },
  };
}
