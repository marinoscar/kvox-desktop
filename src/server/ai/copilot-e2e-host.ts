import { join } from 'node:path';

import { createCopilotMockTransport, type PreparedCopilotRuntime } from '@marinoscar/kvox-ai/copilot';

import type { CopilotHost } from './copilot-host.js';

// =============================================================================
// A Copilot host for the end-to-end test (marinoscar/kvox-desktop#22)
// =============================================================================
//
// Only `tests/e2e/copilot.spec.ts` uses it: the main process asks for it when
// KVOX_E2E_COPILOT_MOCK=1 AND the app is not packaged (`start.copilotE2eMock`),
// so an installed app never reaches this file. It stands in for the two things
// that need the outside world: the runtime (missing until a short, visible
// "download" has run) and the transport (the packages' own mock: signed out until
// a delayed sign-in finishes, then a note answer). Nothing here opens a socket.
// It holds no Copilot logic: the lifecycle, the consent and the routing are the
// real ones (`copilot-service.ts`).
// =============================================================================

/** The text every note generated through this host carries (the spec looks for it). */
export const E2E_COPILOT_NOTE_TEXT = '# Meeting notes\n\n- Joe sends the budget by Friday.\n- Generated on Copilot: copilotzebra.\n';

/** How long the fake download and the fake sign-in take, so the spec can see their states. */
const DOWNLOAD_MS = 4_000;
const SIGN_IN_MS = 2_500;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}

export function createE2eCopilotHost(dataDirectory: string): CopilotHost {
  const transport = createCopilotMockTransport({ signedIn: false });
  transport.scriptSignIn({
    challenge: { kind: 'device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  });
  transport.onSend(() => ({ kind: 'answer', text: E2E_COPILOT_NOTE_TEXT }));
  // The user takes a moment to authorize: the dialog with the code stays visible meanwhile.
  const waitForSignIn = transport.waitForSignIn.bind(transport);
  transport.waitForSignIn = async (signal) => {
    await delay(SIGN_IN_MS, signal);
    return waitForSignIn(signal);
  };

  const prepared: PreparedCopilotRuntime = {
    runtimePath: join(dataDirectory, 'runtime', 'copilot-runtime'),
    baseDirectory: join(dataDirectory, 'home'),
    workingDirectory: join(dataDirectory, 'work'),
    version: '1.0.98',
    source: 'downloaded',
    verified: true,
  };
  let installed = false;

  return {
    dataDirectory,
    canDownload: true,
    async prepareRuntime(request) {
      if (installed) return prepared;
      if (!request.download) throw Object.assign(new Error('The Copilot runtime is not installed.'), { details: { check: 'runtime_missing' } });
      const total = 100;
      for (let step = 1; step <= 4; step += 1) {
        await delay(DOWNLOAD_MS / 4, request.signal);
        request.onProgress?.({ received: (total * step) / 4, total });
      }
      installed = true;
      return prepared;
    },
    createTransport: () => transport,
  };
}
