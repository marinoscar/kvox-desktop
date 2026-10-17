import { Controller, Get, Inject } from '@nestjs/common';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import { KVOX_AI, type KvoxAiPort, type KvoxPrincipal } from '@marinoscar/kvox-api/ports';

// =============================================================================
// GET /api/desktop/ai: the viewer's AI availability, as the notes screens take it
// =============================================================================
//
// The notes pages take a `NotesAiAccess` (`ai` prop) from their host: whether AI
// is available, whether a key is configured, and which models to offer. In the
// web edition that is the app's own `GET /api/ai-tasks/config`; this is the
// Desktop equivalent, answered from the KVOX_AI port alone (`capabilities()`
// and the model `resolveTask` names without needing a key). Host glue: no
// policy lives here. D3 (marinoscar/kvox#584) replaces the model list with the
// configured provider's.
// =============================================================================

/** The answer: the fields of `NotesAiState` that come from the server. */
export interface DesktopAiState {
  available: boolean;
  keyConfigured: boolean;
  models: Array<{ id: string; label: string }>;
  defaultModel: string | null;
}

@Controller('desktop/ai')
export class DesktopAiController {
  constructor(@Inject(KVOX_AI) private readonly ai: KvoxAiPort) {}

  @Get()
  @KvoxAuth()
  async state(@CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<DesktopAiState> {
    const ctx = { userId: principal.userId, orgId: principal.orgId, feature: 'notes.generate' as const };
    const capabilities = await this.ai.capabilities(ctx);
    if (!capabilities.available) return { available: false, keyConfigured: false, models: [], defaultModel: null };
    try {
      const target = await this.ai.resolveTask(ctx, 'notes.generate', { requireKey: false });
      return { available: true, keyConfigured: true, models: [{ id: target.model, label: target.model }], defaultModel: target.model };
    } catch {
      return { available: true, keyConfigured: false, models: [], defaultModel: null };
    }
  }
}
