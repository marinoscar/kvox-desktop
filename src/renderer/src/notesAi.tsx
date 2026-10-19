import { useEffect, useState } from 'react';

import { kvoxGet, useKvoxHost } from '@marinoscar/kvox-web/core/headless';
import { AiKeyRequired } from '@marinoscar/kvox-web/shell';
import type { NotesAiAccess, NotesAiModel, NotesAiState } from '@marinoscar/kvox-web/notes/ui';

// =============================================================================
// The notes slice's `ai` prop: the viewer's AI availability
// =============================================================================
//
// Read from the host's own `GET /api/desktop/ai` (the server answers it from the
// KVOX_AI port). The web edition's equivalent is apps/web/src/kvox/noteAiAccess.tsx.
// =============================================================================

interface DesktopAiState {
  available: boolean;
  keyConfigured: boolean;
  models: NotesAiModel[];
  defaultModel: string | null;
}

const LOADING: NotesAiState = { isLoading: true, loadError: null, keyConfigured: false, available: false, models: [], defaultModel: null };

function useDesktopAiState(): NotesAiState {
  const host = useKvoxHost();
  const [state, setState] = useState<NotesAiState>(LOADING);
  useEffect(() => {
    let cancelled = false;
    kvoxGet<DesktopAiState>(host, '/desktop/ai')
      .then((ai) => {
        if (!cancelled) setState({ isLoading: false, loadError: null, ...ai });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ ...LOADING, isLoading: false, loadError: error instanceof Error ? error.message : 'Could not read the AI settings' });
      });
    return () => {
      cancelled = true;
    };
  }, [host]);
  return state;
}

// The shared "add your key" state; the AI provider card is the Settings page below.
function DesktopAiKeyRequired() {
  return <AiKeyRequired settingsPath="/settings/ai" />;
}

export const desktopNotesAiAccess: NotesAiAccess = {
  useAiState: useDesktopAiState,
  KeyRequired: DesktopAiKeyRequired,
};
