import { BadRequestException, Body, Controller, Get, Inject, Patch } from '@nestjs/common';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import { KVOX_SETTINGS, type KvoxPrincipal, type KvoxSettingsPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// /api/desktop/knowledge: the connected-knowledge switch (`ai.graphEnabled`)
// =============================================================================
//
// GET    /desktop/knowledge   `{ graphEnabled }`: the renderer mirrors it in
//                             `KvoxWebHost.features()` and in its navigation.
// PATCH  /desktop/knowledge   `{ graphEnabled: boolean }`: writes the system
//                             `ai` namespace bootstrap.ts declares.
//
// Host glue (marinoscar/kvox#620): the slices read the switch per call
// (`GraphAiRunResolver`, `capabilities().graphEnabled`), so a change applies to
// the next graph AI call and the next queued digest without a restart. Off,
// the graph AI routes answer 409 `graph_disabled`; nothing already in the graph
// is removed.
// =============================================================================

/** `GET` and `PATCH /desktop/knowledge`. */
export interface DesktopKnowledgeState {
  graphEnabled: boolean;
}

@Controller('desktop/knowledge')
export class DesktopKnowledgeController {
  constructor(@Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort) {}

  @Get()
  @KvoxAuth()
  async state(): Promise<DesktopKnowledgeState> {
    return this.read();
  }

  @Patch()
  @KvoxAuth()
  async patch(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopKnowledgeState> {
    const graphEnabled = typeof body === 'object' && body !== null ? (body as { graphEnabled?: unknown }).graphEnabled : undefined;
    if (typeof graphEnabled !== 'boolean') throw new BadRequestException('Expected { "graphEnabled": true | false }');
    await this.settings.patchSystem<DesktopKnowledgeState>('ai', { graphEnabled }, { actorUserId: principal.userId });
    return this.read();
  }

  private async read(): Promise<DesktopKnowledgeState> {
    const { value } = await this.settings.readSystem<Partial<DesktopKnowledgeState>>('ai');
    return { graphEnabled: value.graphEnabled === true };
  }
}
