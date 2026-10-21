import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import { KvoxApiError, useKvoxHost, useVisiblePolling } from '@marinoscar/kvox-web/core/headless';
import { DOCUMENT_TYPE_LABELS, useSearchIndex } from '@marinoscar/kvox-web/search/headless';

// =============================================================================
// "Semantic search on this device" (marinoscar/kvox#660)
// =============================================================================
//
// The opt-in on-device embedding model, bound to the local server's
// `/api/desktop/ai/local-search` routes through the host's authenticated `http`
// (the same transport as the AI provider page). The server decides everything:
// whether the model may be downloaded (consent), switched on (installed), and
// what `active` means; this page only shows its answer and sends the user's
// choices. Indexing status and "Index now" are the search slice's own hook
// (`useSearchIndex` of `@marinoscar/kvox-web/search/headless`), mounted only
// while on-device search is active.
//
//   GET    /desktop/ai/local-search            the status (polled every second while downloading)
//   POST   /desktop/ai/local-search/download   `{ consent: true }`: THE consent action
//   DELETE /desktop/ai/local-search/download   cancel the download (switches off)
//   PATCH  /desktop/ai/local-search            `{ enabled }`
//   DELETE /desktop/ai/local-search            delete the model, switch off
//
// A 409 `local_search_unavailable` (a build without the embedder) replaces the
// page with one notice.
// =============================================================================

const BASE = '/desktop/ai/local-search';

/** While downloading, the status is read again this often. */
export const LOCAL_SEARCH_POLL_INTERVAL_MS = 1000;

/** `GET /api/desktop/ai/local-search`. */
export interface LocalSearchStatus {
  enabled: boolean;
  active: boolean;
  consentedAt: string | null;
  state: 'missing' | 'downloading' | 'ready' | 'error';
  progress: number | null;
  error: string | null;
  model: string;
  sizeBytes: number;
  hosts: string[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isUnavailable = (error: unknown): boolean => error instanceof KvoxApiError && error.status === 409 && error.code === 'local_search_unavailable';
const megabytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

export function LocalSearchCard() {
  const host = useKvoxHost();
  const [status, setStatus] = useState<LocalSearchStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const read = useCallback(async () => {
    try {
      setStatus(await host.http.request<LocalSearchStatus>('GET', BASE));
    } catch (caught) {
      if (isUnavailable(caught)) setUnavailable(true);
      else setError(message(caught));
    }
  }, [host]);

  useEffect(() => {
    void read();
  }, [read]);

  // Polls only while the model is downloading; any other state stops it (an interval of 0 polls nothing).
  useVisiblePolling(() => void read(), status?.state === 'downloading' ? LOCAL_SEARCH_POLL_INTERVAL_MS : 0);

  const act = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const next = await host.http.request<LocalSearchStatus>(method, path, body === undefined ? undefined : { body });
      if (next) setStatus(next);
      else await read();
    } catch (caught) {
      if (isUnavailable(caught)) setUnavailable(true);
      else setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const download = () => act('POST', `${BASE}/download`, { consent: true });
  const cancel = () => act('DELETE', `${BASE}/download`);
  const setEnabled = (enabled: boolean) => act('PATCH', BASE, { enabled });
  const remove = async () => {
    setConfirmRemove(false);
    await act('DELETE', BASE);
  };

  if (unavailable) {
    return (
      <Alert severity="info" role="status">
        On-device search is not available in this build.
      </Alert>
    );
  }

  const errorAlert = error && (
    <Alert severity="error" role="alert">
      {error}
    </Alert>
  );

  if (!status) {
    return (
      <Stack spacing={2}>
        {errorAlert || <Typography variant="body2">Loading…</Typography>}
      </Stack>
    );
  }

  const size = megabytes(status.sizeBytes);
  const ready = status.state === 'ready';

  let body;
  if (status.state === 'downloading') {
    const percent = Math.round((status.progress ?? 0) * 100);
    body = (
      <Stack spacing={1}>
        <Typography variant="body2">
          Downloading {status.model} ({size})… {percent}%
        </Typography>
        <LinearProgress variant="determinate" value={percent} aria-label="Model download progress" />
        <Box>
          <Button onClick={() => void cancel()} disabled={busy}>
            Cancel
          </Button>
        </Box>
      </Stack>
    );
  } else if (status.state === 'error') {
    body = (
      <Alert
        severity="error"
        role="alert"
        action={
          <Button color="inherit" size="small" onClick={() => void download()} disabled={busy}>
            Try again
          </Button>
        }
      >
        The model download failed{status.error ? `: ${status.error}` : '.'}
      </Alert>
    );
  } else if (!ready) {
    // Missing, or a switch left on by a download that never finished: the same consent, the same button.
    body = (
      <Stack spacing={2}>
        <Typography variant="body2">Turning it on does this, and only this:</Typography>
        <Box component="ul" sx={{ m: 0, pl: 3 }}>
          <Typography component="li" variant="body2">
            A one-time download of the {status.model} model ({size}) from Hugging Face
            {status.hosts.length > 0 ? ` (${status.hosts.join(', ')})` : ''}.
          </Typography>
          <Typography component="li" variant="body2">
            The download is verified by checksum and stored in the KVox data folder on this computer (it is not part of your backups).
          </Typography>
          <Typography component="li" variant="body2">
            After that, nothing leaves this device: your notes and transcripts are indexed and searched here.
          </Typography>
        </Box>
        <Box>
          <Button variant="contained" onClick={() => void download()} disabled={busy}>
            Download and turn on
          </Button>
        </Box>
      </Stack>
    );
  } else {
    body = (
      <Stack spacing={2}>
        {status.active && (
          <Alert severity="success" role="status">
            On — searching on this device
          </Alert>
        )}
        <FormControlLabel
          control={
            <Switch
              checked={status.enabled}
              disabled={busy}
              onChange={(event) => void setEnabled(event.target.checked)}
            />
          }
          label="Semantic search on this device"
        />
        {status.active && <LocalIndexStatus />}
        <Box>
          <Button color="error" onClick={() => setConfirmRemove(true)} disabled={busy}>
            Remove model
          </Button>
        </Box>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2">
        Finds your notes and transcripts by meaning, not just by their exact words. It runs entirely on this computer: no API key,
        and it works offline. Search and Ask use it.
      </Typography>
      {body}
      {errorAlert}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)} aria-labelledby="local-search-remove-title">
        <DialogTitle id="local-search-remove-title">Remove the on-device model?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This frees about {size}. Search then falls back to your AI provider, or to full-text search when there is none. You can
            download the model again at any time.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)}>Keep it</Button>
          <Button color="error" onClick={() => void remove()}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/** The search slice's indexing status, as it reports it, and its "Index now". */
function LocalIndexStatus() {
  const index = useSearchIndex();

  return (
    <Stack spacing={1}>
      {index.isLoading && <Typography variant="body2">Loading the index status…</Typography>}
      {index.loadError && (
        <Alert severity="error" role="alert">
          {index.loadError}
        </Alert>
      )}
      {index.status && (
        <Stack spacing={0.5}>
          {index.status.types.map((counts) => (
            <Typography key={counts.type} variant="body2">
              {DOCUMENT_TYPE_LABELS[counts.type]?.plural ?? counts.type}: {counts.indexed} indexed, {counts.pending} pending
            </Typography>
          ))}
          {index.status.model && (
            <Typography variant="body2" color="text.secondary">
              Model: {index.status.model}
            </Typography>
          )}
        </Stack>
      )}
      <Box>
        <Button variant="outlined" onClick={() => void index.requestIndex()} disabled={index.isIndexing}>
          Index now
        </Button>
      </Box>
      {index.indexError && (
        <Alert severity="error" role="alert">
          {index.indexError}
        </Alert>
      )}
    </Stack>
  );
}
