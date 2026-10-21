import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import { KVOX_AI, type KvoxAiPort, type KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { CopilotSettingsPatchSchema, type CopilotSignInChallenge, type CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { CopilotConflictError } from './ai/copilot-service.js';
import { DESKTOP_AI_PROVIDERS, needsKey, type DesktopAiSettings } from './ai/desktop-ai-settings.js';
import {
  LocalSearchConflictError,
  isSelectableProvider,
  type DesktopAi,
  type DesktopAiKeyStatus,
  type DesktopAiKeyTestResult,
  type DesktopLocalSearchStatus,
} from './ai/desktop-ai.js';
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
// POST   /desktop/ai/keys/:provider/test
//                                     `{ apiKey? }`: asks the provider whether the
//                                     typed key (or the stored one) works, through
//                                     the adapter's `verifyKey`, on this server. The
//                                     answer is the platform's `AiProbeResult` shape,
//                                     always 200 (`success` is the verdict); a refused
//                                     host (egress) or a rejected key is a readable
//                                     check, never the key.
//
// GitHub Copilot is one of the three AI providers (marinoscar/kvox-desktop#21;
// `settings.provider` is `openai`, `openai-compatible` or `copilot`, never off).
// Its endpoints below; every response is a `CopilotStatus` plus the `allowedHosts`
// the egress guard allows now:
//
// GET    /desktop/ai/copilot/status           enabled, signedIn, login, runtime
//                                             state, models, unavailable tasks.
// PATCH  /desktop/ai/copilot                  `Partial<CopilotSettings>`; `enabled` is the
//                                             provider choice (`true`: provider `copilot`,
//                                             `false`: back to `openai` when Copilot is the
//                                             provider), and choosing it needs the current
//                                             consent (409 `consent_required`).
// POST   /desktop/ai/copilot/sign-in          a `CopilotSignInChallenge`.
// POST   /desktop/ai/copilot/sign-in/wait     long-poll: resolves when signed in;
//                                             abortable (the client hanging up
//                                             cancels the flow).
// POST   /desktop/ai/copilot/sign-out
// POST   /desktop/ai/copilot/runtime/download starts the opt-in download (202);
//                                             progress shows in the status.
// DELETE /desktop/ai/copilot/runtime/download cancels it.
// DELETE /desktop/ai/copilot/data             "Remove Copilot data" (`?includeRuntime=true`
//                                             also removes the downloaded runtime); only
//                                             while Copilot is not the provider (409 `copilot_enabled`).
//
// 409s: `runtime_not_ready`, `runtime_download_unavailable`, `copilot_disabled`,
// `sign_in_not_started`, `consent_required`; a sign-in that ends signed out is
// `AI_KEY_REQUIRED` with `details.signInReason`.
//
// On-device semantic search (marinoscar/kvox#660); every response is a `DesktopLocalSearchStatus`
// `{ enabled, active, consentedAt, state, progress, error, model, sizeBytes, hosts }`:
//
// GET    /desktop/ai/local-search             the status. `state` is missing | downloading |
//                                             ready | error; `progress` 0..1 while downloading.
// POST   /desktop/ai/local-search/download    `{ consent: true }` (409 `consent_required`
//                                             without it): THE consent action. Records
//                                             `consentedAt`, switches the feature on, allows the
//                                             download hosts while it runs, starts it (202).
// DELETE /desktop/ai/local-search/download    cancels it and switches the feature off.
// PATCH  /desktop/ai/local-search             `{ enabled: boolean }`; on needs the installed model
//                                             (409 `model_not_ready`) and consent (409
//                                             `consent_required`).
// DELETE /desktop/ai/local-search             cancels any download, deletes the model, switches off.
//
// 409s also: `local_search_unavailable` (a build without the embedder).
//
// Host glue (marinoscar/kvox#584): no AI policy lives here. ⚠ No response
// carries a key or a token.
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
  /** Tasks no provider can serve now, each with the missing capability (Ask on a Copilot model that cannot call tools, with no OpenAI key). */
  unavailableTasks: Array<{ task: string; reason: 'needs_tool_calling' | 'needs_embeddings' }>;
}

/** Every Copilot response: the status, and the hosts the egress guard allows now (for the footer). */
export type DesktopCopilotStatus = CopilotStatus & { allowedHosts: string[] };

/** `GET /desktop/ai/settings`. */
export interface DesktopAiSettingsView {
  settings: DesktopAiSettings;
  providers: Array<{
    id: string;
    label: string;
    implemented: boolean;
    /** True for a slot the user may choose as THE provider (all three). */
    primary: boolean;
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
    const unavailableTasks = await this.desktopAi.unavailableTasks();
    if (!configured) return { available: false, keyConfigured: false, models: [], defaultModel: null, unavailableTasks };
    return { available: true, keyConfigured: capabilities.available, models, defaultModel: modelState.policy.defaultModel, unavailableTasks };
  }

  @Get('settings')
  @KvoxAuth()
  async settings(): Promise<DesktopAiSettingsView> {
    return this.view(await this.desktopAi.read());
  }

  @Patch('settings')
  @KvoxAuth()
  async patch(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopAiSettingsView> {
    return this.view(await this.localSearchCall(() => this.desktopAi.update(body, principal.userId)));
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

  @Post('keys/:provider/test')
  @HttpCode(200)
  @KvoxAuth()
  async testKey(@Param('provider') provider: string, @Body() body: unknown): Promise<DesktopAiKeyTestResult> {
    const apiKey = typeof body === 'object' && body !== null ? (body as { apiKey?: unknown }).apiKey : undefined;
    return this.desktopAi.testKey(provider, apiKey);
  }

  // ---- GitHub Copilot ---------------------------------------------------------

  @Get('copilot/status')
  @KvoxAuth()
  async copilotStatus(): Promise<DesktopCopilotStatus> {
    return this.copilotView();
  }

  @Patch('copilot')
  @KvoxAuth()
  async copilotUpdate(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopCopilotStatus> {
    const parsed = CopilotSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { code: 'ai_settings_invalid', message: parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'copilot'}: ${issue.message}`).join('; ') },
        400,
      );
    }
    await this.copilotCall(() => this.desktopAi.updateCopilot(parsed.data, principal.userId));
    return this.copilotView();
  }

  @Post('copilot/sign-in')
  @HttpCode(200)
  @KvoxAuth()
  async copilotSignIn(): Promise<CopilotSignInChallenge> {
    return this.copilotCall(() => this.desktopAi.copilotSignInStart());
  }

  @Post('copilot/sign-in/wait')
  @HttpCode(200)
  @KvoxAuth()
  async copilotSignInWait(@Res({ passthrough: true }) reply: FastifyReply): Promise<DesktopCopilotStatus> {
    // A client that hangs up before the answer cancels the sign-in flow.
    const aborted = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) aborted.abort();
    };
    reply.raw.once('close', onClose);
    try {
      await this.copilotCall(() => this.desktopAi.copilotSignInWait(aborted.signal));
    } finally {
      reply.raw.off('close', onClose);
    }
    return this.copilotView();
  }

  @Post('copilot/sign-out')
  @HttpCode(200)
  @KvoxAuth()
  async copilotSignOut(): Promise<DesktopCopilotStatus> {
    await this.copilotCall(() => this.desktopAi.copilotSignOut());
    return this.copilotView();
  }

  @Post('copilot/runtime/download')
  @HttpCode(202)
  @KvoxAuth()
  async copilotRuntimeDownload(): Promise<DesktopCopilotStatus> {
    await this.copilotCall(() => this.desktopAi.copilotStartDownload());
    return this.copilotView();
  }

  @Delete('copilot/runtime/download')
  @KvoxAuth()
  async copilotRuntimeDownloadCancel(): Promise<DesktopCopilotStatus> {
    await this.desktopAi.copilotCancelDownload();
    return this.copilotView();
  }

  @Delete('copilot/data')
  @KvoxAuth()
  async copilotRemoveData(@Query('includeRuntime') includeRuntime?: string): Promise<{ removed: string[]; keptRuntime: boolean }> {
    return this.copilotCall(() => this.desktopAi.copilotRemoveData(includeRuntime === 'true'));
  }

  // ---- On-device semantic search ----------------------------------------------

  @Get('local-search')
  @KvoxAuth()
  async localSearchStatus(): Promise<DesktopLocalSearchStatus> {
    return this.desktopAi.localSearchStatus();
  }

  @Post('local-search/download')
  @HttpCode(202)
  @KvoxAuth()
  async localSearchDownload(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopLocalSearchStatus> {
    const consent = typeof body === 'object' && body !== null ? (body as { consent?: unknown }).consent : undefined;
    return this.localSearchCall(() => this.desktopAi.localSearchStartDownload(consent, principal.userId));
  }

  @Delete('local-search/download')
  @KvoxAuth()
  async localSearchDownloadCancel(@CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<DesktopLocalSearchStatus> {
    return this.localSearchCall(() => this.desktopAi.localSearchCancelDownload(principal.userId));
  }

  @Patch('local-search')
  @KvoxAuth()
  async localSearchUpdate(@CurrentKvoxPrincipal() principal: KvoxPrincipal, @Body() body: unknown): Promise<DesktopLocalSearchStatus> {
    const enabled = typeof body === 'object' && body !== null ? (body as { enabled?: unknown }).enabled : undefined;
    if (typeof enabled !== 'boolean') {
      throw new HttpException({ code: 'ai_settings_invalid', message: 'enabled: expected true or false' }, 400);
    }
    return this.localSearchCall(() => this.desktopAi.localSearchSetEnabled(enabled, principal.userId));
  }

  @Delete('local-search')
  @KvoxAuth()
  async localSearchRemove(@CurrentKvoxPrincipal() principal: KvoxPrincipal): Promise<DesktopLocalSearchStatus> {
    return this.localSearchCall(() => this.desktopAi.localSearchRemove(principal.userId));
  }

  /** Answers a local-search conflict as its 409. */
  private async localSearchCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LocalSearchConflictError) {
        throw new HttpException({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, 409);
      }
      throw error;
    }
  }

  private async copilotView(): Promise<DesktopCopilotStatus> {
    return { ...(await this.desktopAi.copilotStatus()), allowedHosts: this.egress.allowedHosts };
  }

  /** Runs a Copilot operation and answers its failures as the endpoint's HTTP errors (messages redacted). */
  private async copilotCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw await copilotHttpError(error);
    }
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

/** An error of a Copilot operation as the HTTP error the endpoint answers (`HttpException` passes through). */
async function copilotHttpError(error: unknown): Promise<HttpException> {
  if (error instanceof HttpException) return error;
  if (error instanceof CopilotConflictError) return new HttpException({ code: error.code, message: error.message }, 409);
  const { redactTokens } = await import('@marinoscar/kvox-ai/copilot');
  const body = (error as { getResponse?: () => { code?: unknown; message?: unknown; details?: unknown } } | null)?.getResponse?.();
  if (body && typeof body.code === 'string' && typeof (error as { getStatus?: unknown }).getStatus === 'function') {
    const code = body.code;
    // A sign-in that ends signed out is a 409 (it is the user's state to fix), not the platform's 403.
    const status = code === 'AI_KEY_REQUIRED' ? 409 : (error as { getStatus(): number }).getStatus();
    return new HttpException(
      { code, message: redactTokens(String(body.message ?? 'GitHub Copilot failed.')), ...(body.details !== undefined ? { details: body.details } : {}) },
      status,
    );
  }
  // Anything else is the runtime failing: say so, without its text if it could carry a token.
  const message = error instanceof Error ? redactTokens(error.message) : 'GitHub Copilot failed.';
  return new HttpException({ code: 'AI_PROVIDER_UNAVAILABLE', message }, 503);
}
