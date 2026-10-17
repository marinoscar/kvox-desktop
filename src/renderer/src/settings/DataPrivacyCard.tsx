import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useKvoxHost } from '@marinoscar/kvox-web/core/headless';

import type { SecretStorageStatus } from '../../../shared/protocol';

// =============================================================================
// "Data and privacy": the data folder, Export data / Restore, saved keys
// =============================================================================
//
// Export and Restore pick a file with the native dialog (the preload), enqueue
// the job (`/api/desktop/backup/*`) and poll it. A finished restore makes the
// main process restart the server and reload this window, so the card only
// says so. The secret-storage line warns when Linux has no keyring
// (`basic_text`) and records the user's explicit consent; without it the
// server refuses to save a key (marinoscar/kvox#583).
// =============================================================================

type Operation = { kind: 'export' | 'restore'; jobId: string; path: string };
type Outcome = { severity: 'success' | 'error' | 'info'; text: string };
type JobState = { status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'; error: string | null };

export function DataPrivacyCard() {
  const host = useKvoxHost();
  const [folder, setFolder] = useState<string>('');
  const [storage, setStorage] = useState<SecretStorageStatus | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void window.kvoxDesktop.dataFolder().then((path) => mounted.current && setFolder(path));
    void window.kvoxDesktop.secretStorage().then((status) => mounted.current && setStorage(status));
    return () => {
      mounted.current = false;
    };
  }, []);

  // Poll the running job once a second until it settles.
  useEffect(() => {
    if (!operation) return;
    const timer = setInterval(() => {
      host.http
        .request<JobState>('GET', `/desktop/backup/jobs/${operation.jobId}`)
        .then((job) => {
          if (!mounted.current || job.status === 'pending' || job.status === 'running') return;
          setOperation(null);
          if (job.status !== 'succeeded') setOutcome({ severity: 'error', text: job.error ?? 'The job did not finish.' });
          else if (operation.kind === 'export') setOutcome({ severity: 'success', text: `Saved to ${operation.path}` });
          else setOutcome({ severity: 'info', text: 'Backup checked. KVox is restarting to restore it.' });
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [host, operation]);

  const start = useCallback(
    async (kind: Operation['kind'], path: string) => {
      setOutcome(null);
      try {
        const { jobId } = await host.http.request<{ jobId: string }>('POST', `/desktop/backup/${kind}`, { body: { path } });
        setOperation({ kind, jobId, path });
      } catch (error) {
        setOutcome({ severity: 'error', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [host],
  );

  const exportData = async () => {
    const path = await window.kvoxDesktop.chooseBackupTarget();
    if (path) await start('export', path);
  };
  const chooseRestore = async () => {
    const path = await window.kvoxDesktop.chooseBackupSource();
    if (path) setConfirmRestore(path);
  };
  const acceptPlaintext = async (accepted: boolean) => setStorage(await window.kvoxDesktop.acceptPlaintextSecrets(accepted));

  return (
    <Stack spacing={2}>
      <Typography variant="body2">
        Everything KVox keeps (notes, transcripts, the graph, documents, settings) is stored on this device, in{' '}
        <code>{folder || '…'}</code>. Only the AI provider you configure receives text, when you generate a note or extract the graph.
      </Typography>

      <Stack direction="row" spacing={1}>
        <Button variant="outlined" onClick={() => void exportData()} disabled={operation !== null}>
          Export data…
        </Button>
        <Button variant="outlined" color="warning" onClick={() => void chooseRestore()} disabled={operation !== null}>
          Restore…
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A backup holds the database and every document. Saved API keys are not included: enter them again after a restore.
      </Typography>
      {operation && <LinearProgress aria-label={operation.kind === 'export' ? 'Exporting' : 'Checking the backup'} />}
      {outcome && (
        <Alert severity={outcome.severity} role="status">
          {outcome.text}
        </Alert>
      )}

      {storage?.backend === 'basic_text' && (
        <Alert severity="warning" role="alert">
          No system keyring is available, so saved API keys would be stored without real encryption. KVox refuses to save keys until
          a keyring (GNOME Keyring, KWallet) is set up, or you accept this below.
          <FormControlLabel
            sx={{ display: 'flex', mt: 1 }}
            control={<Checkbox checked={storage.plaintextAccepted} onChange={(event) => void acceptPlaintext(event.target.checked)} />}
            label="Store keys without system encryption on this device"
          />
        </Alert>
      )}
      {storage && storage.backend !== 'basic_text' && (
        <Typography variant="body2" color="text.secondary">
          {storage.available ? 'Saved API keys are encrypted by the operating system keychain.' : 'This system offers no keychain: keys cannot be saved.'}
        </Typography>
      )}

      <Dialog open={confirmRestore !== null} onClose={() => setConfirmRestore(null)}>
        <DialogTitle>Restore this backup?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Everything currently in KVox is replaced by the backup. KVox checks the file first and restarts to restore it.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRestore(null)}>Cancel</Button>
          <Button
            color="warning"
            onClick={() => {
              const path = confirmRestore;
              setConfirmRestore(null);
              if (path) void start('restore', path);
            }}
          >
            Restore
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
