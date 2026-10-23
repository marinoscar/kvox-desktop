import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Backdrop from '@mui/material/Backdrop';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import FolderCopyIcon from '@mui/icons-material/FolderCopy';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import { noteImportBatchPath } from '@marinoscar/kvox-web/notes/ui';

import type { ImportOutcome } from '../../../shared/protocol';

// =============================================================================
// Import: "Import…", drag and drop, and opening what was created (marinoscar/kvox#585)
// =============================================================================
//
// The shell asks the main process to import (the dialog, or the dropped files'
// paths); the main process streams each file to the local server's upload routes
// and answers what was created. This file only decides where to go next:
//
//   note documents (Markdown, text,   -> the import batch's progress page (the
//   PDF, Word, PowerPoint)               notes slice's own, marinoscar/kvox-desktop#47)
//   a note (a KVox note export)      -> the note
//   a transcript (a JSON export)     -> "New note" with the transcript chosen
//
// "New note" is the notes slice's own page (`NewNotePage`, its template picker);
// its `?transcriptId=` pre-selects the import. A refusal shows the server's own
// sentence (the slice's 400 or 413).
//
// The drop target is the whole window, in the CAPTURE phase: it takes every
// file drop before a page's own drop zone (the notes page's `NotesDropZone`)
// sees it, so a drop is imported once, by one path that also knows transcripts
// and note exports.
// =============================================================================

interface ImportContextValue {
  /** True while files are being imported. */
  busy: boolean;
  /** Opens the native dialog and imports what the user chose. */
  chooseAndImport(): void;
}

const ImportContext = createContext<ImportContextValue | null>(null);

/** The import state, for the "Import…" button. */
export function useImport(): ImportContextValue {
  const value = useContext(ImportContext);
  if (!value) throw new Error('useImport needs <ImportProvider>');
  return value;
}

/** Where a created item opens. */
export function importTarget(outcome: Extract<ImportOutcome, { ok: true }>): string {
  if (outcome.kind === 'batch') return noteImportBatchPath(outcome.id);
  if (outcome.kind === 'note') return `/notes/${encodeURIComponent(outcome.id)}`;
  if (outcome.kind === 'transcript') return `/notes/new?transcriptId=${encodeURIComponent(outcome.id)}`;
  return `/notes/new?objectId=${encodeURIComponent(outcome.id)}&documentName=${encodeURIComponent(outcome.title)}`;
}

/** True when a drag carries files (not text or a link dragged inside the page). */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Provides the import to the shell and makes the whole window a drop target. */
export function ImportProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [failures, setFailures] = useState<Extract<ImportOutcome, { ok: false }>[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  const run = useCallback(
    async (task: () => Promise<ImportOutcome[] | null>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setFailures([]);
      try {
        const outcomes = await task();
        if (!outcomes) return;
        const done = outcomes.filter((outcome): outcome is Extract<ImportOutcome, { ok: true }> => outcome.ok);
        setFailures(outcomes.filter((outcome): outcome is Extract<ImportOutcome, { ok: false }> => !outcome.ok));
        // Note documents went into a batch: its progress page is where to look, whatever else came along.
        const batch = done.find((outcome) => outcome.kind === 'batch');
        if (batch) {
          if (done.length > 1) setNotice(`Imported ${done.length - 1} more ${done.length === 2 ? 'file' : 'files'} beside the documents.`);
          navigate(importTarget(batch));
        } else if (done.length === 1) navigate(importTarget(done[0]));
        else if (done.length > 1) {
          setNotice(`Imported ${done.length} files.`);
          navigate('/notes');
        }
      } catch (error) {
        setFailures([{ ok: false, filename: '', message: error instanceof Error ? error.message : 'The import failed.' }]);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [navigate],
  );

  const chooseAndImport = useCallback(() => void run(() => window.kvoxDesktop.importFromDialog()), [run]);

  useEffect(() => {
    let depth = 0;
    // Capture phase, and the event stops here: a page's own drop zone never sees a file drag.
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the drop is refused (and Chromium would open the file).
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void run(() => window.kvoxDesktop.importDropped(files));
    };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
    };
  }, [run]);

  const value = useMemo(() => ({ busy, chooseAndImport }), [busy, chooseAndImport]);

  return (
    <ImportContext.Provider value={value}>
      {children}
      {failures.length > 0 && (
        <Box sx={{ position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: (theme) => theme.zIndex.snackbar, maxWidth: 640, mx: 'auto' }}>
          <Alert severity="error" onClose={() => setFailures([])}>
            <Stack spacing={0.5}>
              {failures.map((failure, index) => (
                <Typography key={`${failure.filename}-${index}`} variant="body2" data-testid="import-error">
                  {failure.message}
                </Typography>
              ))}
            </Stack>
          </Alert>
        </Box>
      )}
      <Snackbar open={notice !== null} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice ?? ''} />
      <Backdrop open={dragging || busy} sx={{ zIndex: (theme) => theme.zIndex.modal + 1, color: '#fff', flexDirection: 'column', gap: 2 }}>
        {busy ? <CircularProgress color="inherit" aria-label="Importing" /> : <UploadFileIcon sx={{ fontSize: 64 }} />}
        <Typography variant="h6" component="p">
          {busy ? 'Importing…' : 'Drop to import: Markdown, text, PDF, Word, PowerPoint or transcript JSON'}
        </Typography>
      </Backdrop>
    </ImportContext.Provider>
  );
}

/** "Import…", beside "New note" in the Notes header. */
export function ImportButton() {
  const { busy, chooseAndImport } = useImport();
  return (
    <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={chooseAndImport} disabled={busy}>
      Import…
    </Button>
  );
}

/**
 * The Notes header's actions on Desktop: "Import…" (the native dialog, every kind: note documents, transcript
 * JSON, note exports) instead of the package's browser-picker "Import notes", and the package's "Libraries"
 * link to the folders kept in sync.
 */
export function DesktopNotesActions() {
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <ImportButton />
      <Button variant="outlined" component={RouterLink} to="/notes/libraries" startIcon={<FolderCopyIcon />} sx={{ whiteSpace: 'nowrap' }}>
        Libraries
      </Button>
    </Box>
  );
}
