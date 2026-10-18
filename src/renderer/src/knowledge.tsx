import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { DesktopConnection } from '../../shared/protocol';

// =============================================================================
// The connected-knowledge switch on the renderer side (marinoscar/kvox#620)
// =============================================================================
//
// The server's `ai.graphEnabled` (`/api/desktop/knowledge`), read once when the
// window opens and written by the settings card. `undefined` while unknown: the
// shell waits for it before rendering the routes, and the slices keep the graph
// UI hidden (`features().graphEnabled` must be exactly `true`). The shell
// rebuilds the `KvoxWebHost` when it changes, so every slice re-reads it.
// =============================================================================

export interface DesktopKnowledge {
  graphEnabled: boolean | undefined;
  /** Writes the switch; resolves once the server has it. */
  setGraphEnabled(enabled: boolean): Promise<void>;
}

const KnowledgeContext = createContext<DesktopKnowledge>({
  graphEnabled: undefined,
  setGraphEnabled: async () => undefined,
});

export const DesktopKnowledgeProvider = KnowledgeContext.Provider;

export function useDesktopKnowledge(): DesktopKnowledge {
  return useContext(KnowledgeContext);
}

async function knowledgeRequest(connection: DesktopConnection, init?: { graphEnabled: boolean }): Promise<boolean> {
  const response = await fetch(`${connection.baseUrl}/api/desktop/knowledge`, {
    method: init ? 'PATCH' : 'GET',
    headers: { Authorization: `Bearer ${connection.token}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
    ...(init ? { body: JSON.stringify(init) } : {}),
  });
  if (!response.ok) throw new Error(`Connected knowledge: the server answered ${response.status}`);
  return ((await response.json()) as { graphEnabled: boolean }).graphEnabled === true;
}

/** The switch's state for the shell: read on mount, written through the server. */
export function useKnowledgeState(connection: DesktopConnection): DesktopKnowledge {
  const [graphEnabled, setState] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let live = true;
    // A failed read leaves the graph off: the local server answers everything else too.
    void knowledgeRequest(connection)
      .catch(() => false)
      .then((value) => live && setState(value));
    return () => {
      live = false;
    };
  }, [connection]);

  const setGraphEnabled = useCallback(
    async (enabled: boolean) => setState(await knowledgeRequest(connection, { graphEnabled: enabled })),
    [connection],
  );

  return useMemo(() => ({ graphEnabled, setGraphEnabled }), [graphEnabled, setGraphEnabled]);
}
