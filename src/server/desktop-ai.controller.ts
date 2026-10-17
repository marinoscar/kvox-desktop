import { Body, Controller, Delete, Get, Inject, Param, Patch, Put } from '@nestjs/common';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import { KVOX_AI, type KvoxAiPort, type KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { DESKTOP_AI_PROVIDERS, needsKey, type DesktopAiSettings } from './ai/desktop-ai-settings.js';
import { isSelectableProvider, type DesktopAi, type DesktopAiKeyStatus } from './ai/desktop-ai.js';
import type { EgressGuard } from './egress-guard.js';

// =============================================================================
// /api/desktop/ai: the viewer's AI availability and the provider settings
// =============================================================================
//
// GET    /desktop/ai                  what the notes screens take as their `ai`
//                                     prop (`NotesAiAccess`): answered from the
//                                     KVOX_AI port (`capabilities()`) and the
//                                     task-model state. The web edition's
//                                     equivalent is `GET /api/ai-tasks/config`.
// GET    /desktop/ai/settings         the provider settings, each slot's key
//                                     STATUS (configured, a short hint, when) and
//                                     the egress allowlist they produce.
// PATCH  /desktop/ai/settings         a JSON Merge Patch of the settings.
// PUT    /desktop/ai/keys/:provider   `{ apiKey }`: stores it in KVOX_SECRETS.
// DELETE /desktop/ai/keys/:provider   forgets it.
//
// Host glue (marinoscar/kvox#584): no AI policy lives here. ⚠ No response
// carries a key.
// =============================================================================

/** The injection token of the {@link DesktopAi} instance. */
export const DESKTOP_AI = Symbol('kvox-desktop:ai');
/** The injection token of the server's {@link EgressGuard}. */
export const DESKTOP_EGRESS = Symbol('kvox-desktop:egress');

/** `GET /desktop/ai`: the fields of `NotesAiState` that come from the server. */
export interface DesktopAiState {
  available: boolean;
  keyConfigured: boolean;
  models: Array<{ id: string; label: string }>;
  defaultModel: string | null;
}

/** `GET /desktop/ai/settings`. */
export interface DesktopAiSettingsView {
  settings: DesktopAiSettings;
  providers: Array<{
    id: string;
    label: string;
    implemented: boolean;
    toolCalling: boolean;
    note: string;
    /** Whether calls need a stored key under the current settings (false for a keyless server). */
    needsKey: boolean;
    /** `null` for a slot that cannot hold a key yet. */
    key: DesktopAiKeyStatus | null;
  }>;
  /** The non-loopback hosts the server may reach now. */
  allowedHosts: string[];
}

@Controller('desktop/ai')
export class DesktopAiController {
  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(DESKTOP_AI) private readonly desktopAi: DesktopAi,
    @Inject(DESKTOP_EGRESS) private readonly egress: EgressGuard,
  ) {}

  @Get()
  @KvoxAuth()
  async state(@CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<DesktopAiState> {
    const ctx = { userId: principal.userId, orgId: principal.orgId, feature: 'notes.generate' as const };
    const [capabilities, modelState] = await Promise.all([this.ai.capabilities(ctx), this.desktopAi.taskModels.load(principal.userId)]);
    const models = modelState.models.map((model) => ({ id: model.id, label: model.label }));
    // A missing key is "configure it" (the notes page shows its key prompt), not "AI is off".
    const configured = capabilities.available || capabilities.reason === 'ai_key_missing';
    if (!configured) return { available: false, keyConfigured: false, models: [], defaultModel: null };
    return { available: true, keyConfigured: capabilities.available, models, defaultModel: modelState.policy.defaultModel };
  }

  @Get('settings')
  @KvoxAuth()
  async settings(): Promise<DesktopAiSettingsView> {
    return this.view(await this.desktopAi.read());
  }

  @Patch('settings')
  @KvoxAuth()
  async patch(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopAiSettingsView> {
    return this.view(await this.desktopAi.update(body, principal.userId));
  }

  @Put('keys/:provider')
  @KvoxAuth()
  async setKey(
    @CurrentKvoxPrincipal() principal: KvoxPrincipal,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<DesktopAiKeyStatus> {
    const apiKey = typeof body === 'object' && body !== null ? (body as { apiKey?: unknown }).apiKey : undefined;
    return this.desktopAi.setKey(provider, apiKey, principal.userId);
  }

  @Delete('keys/:provider')
  @KvoxAuth()
  async deleteKey(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Param('provider') provider: string): Promise<DesktopAiKeyStatus> {
    return this.desktopAi.deleteKey(provider, principal.userId);
  }

  private async view(settings: DesktopAiSettings): Promise<DesktopAiSettingsView> {
    const providers = await Promise.all(
      DESKTOP_AI_PROVIDERS.map(async (slot) => {
        const id = slot.id;
        if (!isSelectableProvider(id)) return { ...slot, needsKey: false, key: null };
        return { ...slot, needsKey: needsKey(id, settings), key: await this.desktopAi.keyStatus(id) };
      }),
    );
    return { settings, providers, allowedHosts: this.egress.allowedHosts };
  }
}
