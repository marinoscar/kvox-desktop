import { useEffect, useMemo, useRef } from 'react';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';

import type { CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { useCopilotProvider } from '@marinoscar/kvox-web/copilot/headless';
import { CopilotProviderCard } from '@marinoscar/kvox-web/copilot/ui';
import { useKvoxHost } from '@marinoscar/kvox-web/core/headless';

import { createCopilotPort } from './copilotPort';

// =============================================================================
// "Set up GitHub Copilot" on the AI provider page (marinoscar/kvox-desktop#22)
// =============================================================================
//
// The packaged `CopilotProviderCard` (consent, runtime download, sign-in, models,
// what runs on Copilot) bound to the local server through `copilotPort.ts`. Every
// word of the card is the package's; this file only wires it, and opens the
// card's links through the shell, which allows `https://github.com/*` and nothing
// else.
//
// The page renders this section only while Copilot is the chosen provider (or the
// user just picked it and has not answered the consent yet), so the card is
// always `selected`: it has no switch of its own, shows the consent dialog when
// the consent is not current, and its Not now is `onDecline` (the page puts the
// previous provider back). Accepting the consent is `PATCH /desktop/ai/copilot
// {enabled: true, ...}`, which makes Copilot the provider on the server;
// `onChanged` tells the page to read the settings again after every change the
// card saves. `onStatus` hands the page the status (the "Ready" chip, the hosts
// footer); the page draws the one footer, so no `allowedHosts` here.
// `refreshKey` re-reads the status when something outside the card changed it
// (an OpenAI key saved for Ask).
// =============================================================================

export interface CopilotSectionProps {
  /** Every status the hook reads. */
  onStatus?: (status: CopilotStatus) => void;
  /** After the card saved a change (consent, withdrawal, model). */
  onChanged?: () => void | Promise<void>;
  /** The consent dialog's Not now. */
  onDecline: () => void | Promise<void>;
  /** Change it to re-read the status. */
  refreshKey?: number;
}

export function CopilotSection({ onStatus, onChanged, onDecline, refreshKey = 0 }: CopilotSectionProps) {
  const host = useKvoxHost();
  const port = useMemo(() => createCopilotPort(host), [host]);
  const copilot = useCopilotProvider(port);
  const { refresh } = copilot;

  useEffect(() => {
    if (copilot.status) onStatus?.(copilot.status);
  }, [copilot.status, onStatus]);

  // The first value is the mount, which the hook reads already.
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    refresh().catch(() => undefined);
  }, [refreshKey, refresh]);

  if (copilot.error) {
    return (
      <Alert severity="error" role="alert">
        {copilot.error.message}
      </Alert>
    );
  }
  if (!copilot.status || !copilot.settings) return <Typography variant="body2">Loading…</Typography>;

  return (
    <CopilotProviderCard
      status={copilot.status}
      settings={copilot.settings}
      selected
      onDecline={onDecline}
      onUpdate={async (patch) => {
        await copilot.update(patch);
        await onChanged?.();
      }}
      onSignIn={copilot.startSignIn}
      onWaitForSignIn={copilot.waitForSignIn}
      onSignOut={copilot.signOut}
      onDownloadRuntime={copilot.downloadRuntime}
      onCancelRuntimeDownload={() => {
        copilot.cancelRuntimeDownload();
        port
          .cancelRuntimeDownload()
          .then(() => copilot.refresh())
          .catch(() => undefined);
      }}
      onOpenExternal={(url) => {
        void window.kvoxDesktop.openExternal(url);
      }}
    />
  );
}
