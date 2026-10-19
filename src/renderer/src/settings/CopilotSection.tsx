import { useEffect, useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';

import type { CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { useCopilotProvider } from '@marinoscar/kvox-web/copilot/headless';
import { CopilotProviderCard } from '@marinoscar/kvox-web/copilot/ui';
import { useKvoxHost } from '@marinoscar/kvox-web/core/headless';

import { allowedHostsOf, createCopilotPort } from './copilotPort';

// =============================================================================
// "GitHub Copilot" on the AI provider page (marinoscar/kvox-desktop#22)
// =============================================================================
//
// The packaged `CopilotProviderCard` (consent, runtime download, sign-in, models,
// what runs on Copilot) bound to the local server through `copilotPort.ts`. Every
// word of the card is the package's; this file only wires it, and opens the
// card's links through the shell, which allows `https://github.com/*` and nothing
// else. `onStatus` tells the page the status, so its footer follows the hosts the
// egress guard allows now.
// =============================================================================

export function CopilotSection({ onStatus }: { onStatus?: (status: CopilotStatus) => void }) {
  const host = useKvoxHost();
  const port = useMemo(() => createCopilotPort(host), [host]);
  const copilot = useCopilotProvider(port);

  useEffect(() => {
    if (copilot.status) onStatus?.(copilot.status);
  }, [copilot.status, onStatus]);

  if (copilot.error) return <Alert severity="error">{copilot.error.message}</Alert>;
  if (!copilot.status || !copilot.settings) return <Typography variant="body2">Loading…</Typography>;

  return (
    <CopilotProviderCard
      status={copilot.status}
      settings={copilot.settings}
      onUpdate={copilot.update}
      onSignIn={copilot.startSignIn}
      onWaitForSignIn={copilot.waitForSignIn}
      onSignOut={copilot.signOut}
      onDownloadRuntime={copilot.downloadRuntime}
      onCancelRuntimeDownload={copilot.cancelRuntimeDownload}
      onOpenExternal={(url) => {
        void window.kvoxDesktop.openExternal(url);
      }}
      allowedHosts={copilot.status.enabled ? allowedHostsOf(copilot.status) : undefined}
    />
  );
}
