import { useEffect, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { kvoxGet, useKvoxHost } from '@marinoscar/kvox-web/core/headless';

import { ASK_UNAVAILABLE_TOOLTIP, isAskUnavailable, type UnavailableTask } from './askAvailability';

// =============================================================================
// The Ask row of the rail when no provider can answer (marinoscar/kvox-desktop#22, #18)
// =============================================================================
//
// `GET /api/desktop/ai` reports `unavailableTasks`: the tasks no provider can serve now, each with the missing
// capability (Ask needs tool calling, which a Copilot-only setup lacks). The task list is the server's; this
// file only reads it. It is read again on every navigation, so turning Copilot on or saving an OpenAI key in
// Settings is reflected when the user comes back.
//
// The shell's destination has no "disabled" state, so the Ask row is flagged instead: a badge whose `title`
// says what to do, and a click that leads to the AI provider page (where the fix is) rather than to a page that
// cannot answer. `AskAvailability` (mounted once, inside the router and the host) reads the server; the badge
// and the click guard read its answer from a tiny store, because a destination's `badge` and `onClick` are
// module-level functions. A "disabled" destination belongs in the package; see the pull request notes.
// =============================================================================

let unavailable = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (next === unavailable) return;
  unavailable = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reads `unavailableTasks` on every navigation and publishes whether Ask can answer. Renders nothing. */
export function AskAvailability(): null {
  const host = useKvoxHost();
  const { pathname } = useLocation();
  useEffect(() => {
    let cancelled = false;
    kvoxGet<{ unavailableTasks?: UnavailableTask[] }>(host, '/desktop/ai')
      .then((state) => {
        if (!cancelled) publish(isAskUnavailable(state.unavailableTasks));
      })
      .catch(() => {
        // Unreadable: leave Ask enabled; its own page reports a real failure.
        if (!cancelled) publish(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host, pathname]);
  return null;
}

/** The Ask destination's `badge`: a mark with the reason while no provider can answer, else none. */
export function useAskUnavailableBadge(): ReactNode {
  const flagged = useSyncExternalStore(subscribe, () => unavailable);
  return flagged ? (
    <span title={ASK_UNAVAILABLE_TOOLTIP} data-testid="ask-unavailable">
      !
    </span>
  ) : null;
}

/** The Ask destination's `onClick`: while no provider can answer, go to the AI provider page instead. */
export function guardAskNavigation(event: MouseEvent<HTMLElement>): void {
  if (!unavailable) return;
  event.preventDefault();
  window.location.hash = '#/settings/ai';
}
