import type { CopilotSettings, CopilotSignInChallenge, CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import type { CopilotProviderPort } from '@marinoscar/kvox-web/copilot/headless';
import type { KvoxWebHost } from '@marinoscar/kvox-web/core/headless';

// =============================================================================
// The Copilot port: the packaged card's six routes, bound to the local server
// =============================================================================
//
// `useCopilotProvider(port)` of `@marinoscar/kvox-web/copilot/headless` owns the
// state; this file only maps its calls to `/api/desktop/ai/copilot/*` through the
// host's authenticated `http` (host.ts: the per-launch token, no envelope, errors
// as `KvoxApiError`). No Copilot text or logic is defined here, and the renderer
// never sees a token: the server answers "signed in as <login>", nothing more.
//
//   getStatus      GET    /desktop/ai/copilot/status        (CopilotStatus + allowedHosts)
//   getSettings    GET    /desktop/ai/settings              (its `settings.copilot`)
//   update         PATCH  /desktop/ai/copilot, then the stored setting
//   startSignIn    POST   /desktop/ai/copilot/sign-in
//   waitForSignIn  POST   /desktop/ai/copilot/sign-in/wait  (long poll; the abort hangs up)
//   signOut        POST   /desktop/ai/copilot/sign-out
//   downloadRuntime POST  /desktop/ai/copilot/runtime/download (202): it STARTS the download
//                  and resolves; progress is the status (`runtime.state` 'downloading'), which
//                  the hook then polls, and DELETE (`cancelRuntimeDownload`) cancels it
// =============================================================================

const BASE = '/desktop/ai/copilot';

/** Every Copilot response also carries the hosts the egress guard allows now (for the footer). */
export type DesktopCopilotStatus = CopilotStatus & { allowedHosts: string[] };

/** The status' `allowedHosts`, or none when the field is missing. */
export function allowedHostsOf(status: CopilotStatus): string[] {
  const hosts = (status as Partial<DesktopCopilotStatus>).allowedHosts;
  return Array.isArray(hosts) ? hosts : [];
}

interface SettingsView {
  settings: { copilot: CopilotSettings };
}

/** The port, plus the cancel of a started download. */
export interface DesktopCopilotPort extends CopilotProviderPort {
  /** DELETE /desktop/ai/copilot/runtime/download. */
  cancelRuntimeDownload(): Promise<void>;
}

/** The port over `host`; create it once per host (the hook wants a stable port). */
export function createCopilotPort(host: KvoxWebHost): DesktopCopilotPort {
  const getStatus = (): Promise<DesktopCopilotStatus> => host.http.request<DesktopCopilotStatus>('GET', `${BASE}/status`);
  const getSettings = async (): Promise<CopilotSettings> => (await host.http.request<SettingsView>('GET', '/desktop/ai/settings')).settings.copilot;

  return {
    getStatus,
    getSettings,
    async update(patch) {
      await host.http.request<DesktopCopilotStatus>('PATCH', BASE, { body: patch });
      return getSettings();
    },
    startSignIn: () => host.http.request<CopilotSignInChallenge>('POST', `${BASE}/sign-in`),
    async waitForSignIn(signal) {
      await host.http.request<DesktopCopilotStatus>('POST', `${BASE}/sign-in/wait`, { signal });
    },
    async signOut() {
      await host.http.request<DesktopCopilotStatus>('POST', `${BASE}/sign-out`);
    },
    async downloadRuntime(signal) {
      // 202: the server downloads on; the card follows the status and offers Cancel meanwhile.
      await host.http.request<DesktopCopilotStatus>('POST', `${BASE}/runtime/download`, { signal });
    },
    async cancelRuntimeDownload() {
      await host.http.request<DesktopCopilotStatus>('DELETE', `${BASE}/runtime/download`);
    },
  };
}
