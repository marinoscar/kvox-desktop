import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Backdrop from '@mui/material/Backdrop';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import type { ImportOutcome } from '../../../shared/protocol';

// =============================================================================
// Import: "Import…", drag and drop, and opening what was created (marinoscar/kvox#585)
// =============================================================================
//
// The shell asks the main process to import (the dialog, or the dropped files'
// paths); the main process streams each file to the local server's upload routes
// and answers what was created. This file only decides where to go next:
//
//   a note (a KVox note export)      -> the note
//   a transcript (a JSON export)     -> "New note" with the transcript chosen
//   a document (PDF, Markdown, text) -> "New note" with the document chosen
//
// "New note" is the notes slice's own page (`NewNotePage`, its template picker);
// its `?transcriptId=` and `?objectId=` pre-select the import. A refusal shows
// the server's own sentence (the slice's 400 or 413).
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
        if (done.length === 1) navigate(importTarget(done[0]));
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
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the drop is refused (and Chromium would open the file).
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void run(() => window.kvoxDesktop.importDropped(files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
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
          {busy ? 'Importing…' : 'Drop to import: PDF, transcript JSON, Markdown or text'}
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
