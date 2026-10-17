import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import type { UpdateStatus } from '../../../shared/protocol';

// =============================================================================
// "Updates": the opt-in "Check for updates" switch (marinoscar/kvox#587)
// =============================================================================
//
// Off by default (ADR-0004). On, the main process checks GitHub Releases now
// and every six hours, downloads a newer version in the background and
// installs it when KVox quits; the card offers to restart at once. The status
// is polled while a check or a download runs; a poll answered after the user
// flipped the switch is dropped (it would show the old state).
// =============================================================================

const BUSY: ReadonlyArray<UpdateStatus['state']> = ['idle', 'checking', 'downloading'];

function describe(status: UpdateStatus): string {
  switch (status.state) {
    case 'off':
      return 'KVox does not contact any update server.';
    case 'idle':
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `KVox ${status.currentVersion} is the latest version.`;
    case 'downloading':
      return `Downloading KVox ${status.version ?? ''}…`;
    case 'downloaded':
      return `KVox ${status.version ?? ''} is ready. It is installed when KVox quits.`;
    case 'error':
      return `The last check failed: ${status.message ?? 'unknown error'}`;
  }
}

export function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const mounted = useRef(true);
  /** Bumped by every toggle: a status read started before it is stale. */
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const asked = generation.current;
    void window.kvoxDesktop.updates().then((value) => mounted.current && asked === generation.current && setStatus(value));
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!status || !BUSY.includes(status.state)) return;
    const timer = setInterval(() => {
      const asked = generation.current;
      void window.kvoxDesktop.updates().then((value) => mounted.current && asked === generation.current && setStatus(value));
    }, 2000);
    return () => clearInterval(timer);
  }, [status]);

  const toggle = async (enabled: boolean) => {
    const mine = ++generation.current;
    const value = await window.kvoxDesktop.setUpdatesEnabled(enabled);
    if (mounted.current && mine === generation.current) setStatus(value);
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2">
        When on, KVox asks GitHub Releases for a newer version now and every six hours. The request carries no data of yours: it
        downloads public release files, and the installer must be signed by the same publisher as this copy.
      </Typography>
      <FormControlLabel
        control={
          <Switch checked={status?.enabled ?? false} disabled={!status} onChange={(event) => void toggle(event.target.checked)} />
        }
        label="Check for updates"
      />
      {status && (
        <Alert severity={status.state === 'error' ? 'warning' : 'info'} role="status">
          {describe(status)}
        </Alert>
      )}
      {status?.state === 'downloaded' && (
        <Button variant="contained" sx={{ alignSelf: 'flex-start' }} onClick={() => void window.kvoxDesktop.installUpdate()}>
          Restart and install
        </Button>
      )}
    </Stack>
  );
}
