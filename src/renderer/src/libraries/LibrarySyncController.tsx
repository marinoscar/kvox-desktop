import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';

import { useKvoxHost, type KvoxFolderRef } from '@marinoscar/kvox-web/core/headless';
import { isLibrarySyncCancelled, listNoteLibraries, syncLibrary, type LibrarySyncProgress, type NoteLibrary } from '@marinoscar/kvox-web/notes/headless';
import { noteImportBatchPath, noteLibraryPath, syncErrorMessage } from '@marinoscar/kvox-web/notes/ui';

import type { DesktopFileAccess } from '../files';

// =============================================================================
// Note libraries kept in sync on Desktop (marinoscar/kvox-desktop#47)
// =============================================================================
//
// Mounted once in App. Orchestration only: every sync is kvox-web's
// `syncLibrary` (enumerate, scan, hash what the server asks for, upload),
// with the Desktop file port and `sequential: true`.
//
//   at launch     every library bound to a folder on this device is synced
//   on a change   the folder's watcher (debounced 2 s in main) queues the library again
//   on binding    "Add folder" / "Remove" on the library pages (the port's notice)
//                 starts or stops the watcher; the page runs its own first sync
//
// These syncs confirm themselves: the user chose the folder, which is the
// opt-in. The interactive confirmation ("Add folder", "Sync now") stays on the
// packaged pages. One sync at a time, across libraries, shared with those pages
// (kvox-web's library sync coordinator, marinoscar/kvox#725).
//
// The status is a small snackbar ("Syncing notes… 12/40") that links to the
// library until the scan opens an import batch, then to that batch.
// =============================================================================

/** What the snackbar shows. */
interface SyncStatus {
  libraryId: string;
  name: string;
  progress?: LibrarySyncProgress;
  /** Set when finished with something to show. */
  result?: { batchId: string | null; uploaded: number; failed: number };
  error?: string;
}

/** The sentence for a status. */
export function syncStatusText(status: SyncStatus): string {
  if (status.error) return `Could not sync “${status.name}”: ${status.error}`;
  if (status.result) {
    const { uploaded, failed } = status.result;
    const notes = `${uploaded.toLocaleString()} ${uploaded === 1 ? 'note' : 'notes'}`;
    return failed > 0 ? `Synced ${notes} from “${status.name}”; ${failed.toLocaleString()} failed` : `Synced ${notes} from “${status.name}”`;
  }
  const progress = status.progress;
  if (progress?.phase === 'uploading') return `Syncing notes… ${progress.done.toLocaleString()}/${progress.total.toLocaleString()}`;
  if (progress?.phase === 'hashing') return `Checking “${status.name}”… ${progress.done.toLocaleString()}/${progress.total.toLocaleString()}`;
  return `Checking “${status.name}”…`;
}

/** Keeps the bound libraries in sync and shows their progress. Renders only the status snackbar. */
export function LibrarySyncController({ files }: { files: DesktopFileAccess | undefined }): ReactElement | null {
  const host = useKvoxHost();
  // The host is rebuilt when the graph switch flips; the syncs use the latest one without restarting.
  const hostRef = useRef(host);
  hostRef.current = host;
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    if (!files) return undefined;
    const abort = new AbortController();
    const bound = new Map<string, { library: NoteLibrary; ref: KvoxFolderRef; unwatch: () => void }>();

    // A change seen while the library syncs queues exactly one rerun (the coordinator's default).
    const request = (libraryId: string) => {
      const entry = bound.get(libraryId);
      if (!entry || abort.signal.aborted) return;
      const { library, ref } = entry;
      const ticket = syncLibrary({
        host: hostRef.current,
        port: files,
        library,
        ref,
        signal: abort.signal,
        sequential: true,
        confirm: () => true,
        onProgress: (progress) => {
          if (!abort.signal.aborted) setStatus({ libraryId, name: library.name, progress });
        },
      });
      ticket.result.then(
        (result) => {
          if (abort.signal.aborted) return;
          // Nothing uploaded and nothing failed: the folder was already in sync, say nothing.
          if (result.uploaded === 0 && result.failed.length === 0) setStatus(null);
          else setStatus({ libraryId, name: library.name, result: { batchId: result.batchId, uploaded: result.uploaded, failed: result.failed.length } });
        },
        (error: unknown) => {
          // A Stop on the library page cancels this sync too; that is not an error.
          if (abort.signal.aborted || isLibrarySyncCancelled(error)) return;
          setStatus({ libraryId, name: library.name, error: syncErrorMessage(error) });
        },
      );
    };

    const refresh = async (initial: boolean) => {
      const libraries = await listNoteLibraries(hostRef.current);
      if (abort.signal.aborted) return;
      const seen = new Set<string>();
      for (const library of libraries) {
        const ref = await files.getLibraryFolder(library.id).catch(() => null);
        if (abort.signal.aborted) return;
        const previous = bound.get(library.id);
        if (!ref) continue;
        seen.add(library.id);
        if (previous && previous.ref.id === ref.id) {
          previous.library = library;
          continue;
        }
        previous?.unwatch();
        const unwatch = files.watch ? files.watch(ref, () => request(library.id)) : () => undefined;
        bound.set(library.id, { library, ref, unwatch });
        if (initial) request(library.id);
      }
      for (const [libraryId, entry] of bound) {
        if (seen.has(libraryId)) continue;
        entry.unwatch();
        bound.delete(libraryId);
      }
    };

    void refresh(true).catch(() => undefined);
    const offBindings = files.onBindingsChanged(() => void refresh(false).catch(() => undefined));
    return () => {
      // Detaches every request: a sync nobody else holds stops, a queued rerun is dropped.
      abort.abort();
      offBindings();
      for (const entry of bound.values()) entry.unwatch();
      bound.clear();
    };
  }, [files]);

  if (!status) return null;
  const finished = Boolean(status.result || status.error);
  const batchId = status.result?.batchId ?? status.progress?.batchId ?? null;
  const target = batchId ? noteImportBatchPath(batchId) : noteLibraryPath(status.libraryId);
  return (
    <Snackbar
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      // Progress stays while the sync runs; a result goes after a few seconds.
      {...(finished ? { autoHideDuration: 6000 } : {})}
      onClose={(_event, reason) => {
        if (finished && reason !== 'clickaway') setStatus(null);
      }}
      message={<span data-testid="library-sync-status">{syncStatusText(status)}</span>}
      action={
        <Button color="inherit" size="small" component={RouterLink} to={target} onClick={() => finished && setStatus(null)}>
          {batchId ? 'View' : 'Open'}
        </Button>
      }
    />
  );
}
