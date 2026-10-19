import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';

import { kvoxGet, useKvoxHost } from '@marinoscar/kvox-web/core/headless';

import { ASK_UNAVAILABLE_TOOLTIP, isAskUnavailable, type UnavailableTask } from './askAvailability';

// =============================================================================
// The Ask entry of the top bar (marinoscar/kvox-desktop#22)
// =============================================================================
//
// `GET /api/desktop/ai` reports `unavailableTasks`: the tasks no provider can
// serve now, each with the missing capability (Ask needs tool calling, which a
// Copilot-only setup lacks). When `ask.respond` is among them the entry stays,
// disabled, with a tooltip that says what to do, so the reason is visible and
// the entry is not hidden without a word. The task list is the server's; this
// file only reads it. It is read again on every navigation, so turning Copilot on
// or saving an OpenAI key in Settings is reflected when the user comes back.
// =============================================================================

function useAskUnavailable(): boolean {
  const host = useKvoxHost();
  const { pathname } = useLocation();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    kvoxGet<{ unavailableTasks?: UnavailableTask[] }>(host, '/desktop/ai')
      .then((state) => {
        if (!cancelled) setUnavailable(isAskUnavailable(state.unavailableTasks));
      })
      .catch(() => {
        // Unreadable: leave Ask enabled; its own page reports a real failure.
        if (!cancelled) setUnavailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host, pathname]);
  return unavailable;
}

export function AskNavButton() {
  const unavailable = useAskUnavailable();
  if (!unavailable) {
    return (
      <Button component={RouterLink} to="/ask">
        Ask
      </Button>
    );
  }
  return (
    <Tooltip title={ASK_UNAVAILABLE_TOOLTIP}>
      {/* A disabled button fires no events: the span carries the tooltip and the accessible description. */}
      <span aria-label={`Ask. ${ASK_UNAVAILABLE_TOOLTIP}`}>
        <Button disabled aria-disabled>
          Ask
        </Button>
      </span>
    </Tooltip>
  );
}
