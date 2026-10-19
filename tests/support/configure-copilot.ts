import { join } from 'node:path';

import { createCopilotMockTransport, type CopilotMockTransport, type CopilotMockTransportOptions, type PreparedCopilotRuntime } from '@marinoscar/kvox-ai/copilot';

import { AiError } from '@marinoscar/platform-ai-providers';

import { COPILOT_CONSENT_VERSION } from '../../src/server/ai/copilot-contract';
import type { CopilotHost } from '../../src/server/ai/copilot-host';
import type { DesktopAi } from '../../src/server/ai/desktop-ai';

// =============================================================================
// Enabling GitHub Copilot in a test (marinoscar/kvox-desktop#21)
// =============================================================================
//
// The unit-test twin of `configure-ai.ts` (which drives the settings page): a
// Copilot host whose runtime is "ready" (or missing, or downloadable) and whose
// transport is `createCopilotMockTransport`, so no SDK and no runtime are needed,
// and `enableCopilot`, which gives the consent the settings gate asks for and
// switches the add-on on through the same path the endpoint uses.
// =============================================================================

/** What the harness counted. */
export interface CopilotHostCalls {
  prepared: number;
  downloads: number;
  transports: number;
  stopped: number;
  removed: Array<{ includeRuntime?: boolean }>;
}

export interface MockCopilotHost {
  host: CopilotHost;
  transport: CopilotMockTransport;
  calls: CopilotHostCalls;
  /** Resolves a pending download (`runtime: 'downloadable'`). */
  finishDownload(): void;
  /** Reports download progress (`runtime: 'downloadable'`). */
  progress(received: number, total: number): void;
}

export interface MockCopilotHostOptions extends CopilotMockTransportOptions {
  /** `ready` (default): a runtime is bundled. `missing`: none, no download. `downloadable`: none until the download finishes. */
  runtime?: 'ready' | 'missing' | 'downloadable';
}

/** A Copilot host over the mock transport. */
export function mockCopilotHost(options: MockCopilotHostOptions = {}): MockCopilotHost {
  const { runtime = 'ready', ...transportOptions } = options;
  const transport = createCopilotMockTransport(transportOptions);
  const calls: CopilotHostCalls = { prepared: 0, downloads: 0, transports: 0, stopped: 0, removed: [] };
  Object.assign(transport, {
    stop: async () => {
      calls.stopped += 1;
    },
  });
  const dataDirectory = join('/nonexistent', 'kvox-copilot-test');
  const prepared: PreparedCopilotRuntime = {
    runtimePath: join(dataDirectory, 'runtime', 'copilot-runtime'),
    baseDirectory: join(dataDirectory, 'home'),
    workingDirectory: join(dataDirectory, 'work'),
    version: '1.0.98',
    source: 'bundled',
    verified: true,
  };
  let onProgress: ((p: { received: number; total?: number }) => void) | undefined;
  let finish: (() => void) | undefined;
  let installed = runtime === 'ready';
  const host: CopilotHost = {
    dataDirectory,
    canDownload: runtime === 'downloadable',
    async prepareRuntime(request) {
      calls.prepared += 1;
      if (installed) return prepared;
      if (!request.download) throw new AiError('AI_PROVIDER_UNAVAILABLE', 'no runtime', { details: { check: 'runtime_missing' } });
      calls.downloads += 1;
      onProgress = request.onProgress;
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      installed = true;
      return { ...prepared, source: 'downloaded' };
    },
    async createTransport() {
      calls.transports += 1;
      return transport;
    },
    async removeData(options) {
      calls.removed.push(options);
      return { removed: ['home', 'work'], keptRuntime: !options.includeRuntime };
    },
  };
  return {
    host,
    transport,
    calls,
    finishDownload: () => finish?.(),
    progress: (received, total) => onProgress?.({ received, total }),
  };
}

/** The consent a user gives in the settings card for the current text. */
export function currentConsent(): { enabled: true; consentedAt: string; consentVersion: string } {
  return { enabled: true, consentedAt: new Date().toISOString(), consentVersion: COPILOT_CONSENT_VERSION };
}

/** Consents to the current text and switches Copilot on (`PATCH /desktop/ai/copilot`'s path). */
export async function enableCopilot(ai: DesktopAi, actorUserId: string, extra: { model?: string | null } = {}): Promise<void> {
  await ai.updateCopilot({ ...currentConsent(), ...extra }, actorUserId);
}
