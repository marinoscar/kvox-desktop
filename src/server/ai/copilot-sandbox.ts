import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { COPILOT_EGRESS_HOSTS, redactTokens } from '@marinoscar/kvox-ai/copilot';

import { startEgressProxy, type EgressProxy } from './copilot-egress-proxy.js';
import { reapRuntimeProcesses, type ReapOptions } from './copilot-process-reaper.js';

// =============================================================================
// The Copilot runtime sandbox (marinoscar/kvox-desktop#23, ADR-0004)
// =============================================================================
//
// What the server starts, once, when Copilot is enabled, and stops when it is
// disabled and when the app quits:
//
//   1. the allowlisting CONNECT proxy (copilot-egress-proxy.ts) on 127.0.0.1;
//   2. the environment the runtime child process must be started with, so every
//      connection it makes goes through that proxy;
//   3. the cleanup: the runtime is stopped (the host's `stopRuntime` hook, i.e.
//      the transport's `stop`), a runtime that does not stop is killed, and the
//      proxy listener is closed. With Copilot off there is no listener and no
//      process.
//
// HOW THE HOST USES IT (issue #21 wires this into adapter loading):
//
//   const sandbox = await startCopilotRuntimeSandbox({
//     dataDirectory: folder.copilot,
//     log,
//     stopRuntime: () => transport.stop(),
//   });
//   sandbox.apply();   // BEFORE the transport starts the runtime: see below
//   ...
//   await sandbox.stop();   // on disable; `stopCopilotSandboxes()` runs on server close
//
// WHY `apply()`: `createSdkCopilotTransport` of @marinoscar/kvox-ai builds its
// CopilotClient without an `env` option, and the SDK then spawns the runtime
// with a copy of THIS process's `process.env`. So the variables are put into the
// server (utility) process's own environment while the sandbox runs and put
// back by `stop()`. They affect only what reads them: the runtime child. Node's
// fetch and undici ignore HTTPS_PROXY, and the in-process egress guard is
// unaffected. When kvox-ai gains an `env` option on the transport, pass
// `sandbox.env` instead and stop calling `apply()`.
//
// VERIFIED with @github/copilot-sdk 1.0.22 (runtime 1.0.98, linux-x64): the
// runtime honours HTTPS_PROXY (it opened CONNECT api.github.com:443 to a
// listener given as HTTPS_PROXY, with the Proxy-Authorization credentials of the
// proxy URL). So it can be proxied and ADR-0004 needs no amendment for egress.
// =============================================================================

/**
 * What the runtime must NOT inherit from the server's environment:
 * credentials it would sign in with on its own (a user signed in to `gh` would
 * otherwise appear signed in to KVox), and any proxy or telemetry setting the
 * user's shell happens to carry.
 */
const STRIPPED_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ALL_PROXY',
  'all_proxy',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/**
 * The hosts the one-time runtime DOWNLOAD may reach (`prepareCopilotRuntime({ download: { allowedHosts } })`;
 * the same list lets the server's in-process egress guard through for the download only): GitHub's release
 * hosts. A release asset is a redirect from github.com to GitHub's object storage; every hop is checked
 * against this list by `prepareCopilotRuntime`. Not part of {@link COPILOT_EGRESS_HOSTS}: the runtime
 * itself never needs them once installed.
 */
export const COPILOT_RUNTIME_DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/** Options of {@link startCopilotRuntimeSandbox}. */
export interface CopilotSandboxOptions {
  /** `<userData>/copilot` (`DataFolder.copilot`). Created when missing. */
  dataDirectory: string;
  /** The hostnames the runtime may reach. Default: `COPILOT_EGRESS_HOSTS` of `@marinoscar/kvox-ai/copilot` (and nothing else). */
  allowedHosts?: readonly string[];
  /** The server's log sink. Every line is passed through `redactTokens` first. */
  log: (line: string) => void;
  /** Asks the runtime to stop (the transport's `stop`). Awaited for `stopTimeoutMs`. */
  stopRuntime?: () => Promise<void>;
  /** How long `stopRuntime` may take before the runtime is killed. Default 5 s. */
  stopTimeoutMs?: number;
  /** The environment the runtime would inherit. Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Replaces the child-process lookup of the reaper (a test). */
  reaper?: ReapOptions;
  /** Replaces the proxy's upstream connection (a test). */
  connect?: Parameters<typeof startEgressProxy>[0]['connect'];
}

/** A running sandbox. */
export interface CopilotRuntimeSandbox {
  /** The complete environment for the runtime child process. */
  readonly env: NodeJS.ProcessEnv;
  /** Only what differs from the base environment (`undefined` removes a variable). */
  readonly overrides: Readonly<Record<string, string | undefined>>;
  /** The proxy URL (carries credentials: never log it). */
  readonly proxyUrl: string;
  /** The proxy's port on 127.0.0.1. */
  readonly port: number;
  /** Tunnels refused so far. */
  readonly refused: number;
  /** Writes {@link overrides} into `process.env` (restored by `stop()`). Idempotent. */
  apply(): void;
  /** Stops the runtime, kills a straggler, closes the proxy and restores the environment. Idempotent. */
  stop(): Promise<void>;
}

const running = new Set<CopilotRuntimeSandbox>();

/** The sandboxes running now: the server close and the tests use it to prove "off means off". */
export function runningCopilotSandboxes(): readonly CopilotRuntimeSandbox[] {
  return [...running];
}

/** Stops every running sandbox (server close, `before-quit` through the server's `stop` message). */
export async function stopCopilotSandboxes(): Promise<void> {
  await Promise.all([...running].map((sandbox) => sandbox.stop()));
}

/** The variables that force the runtime through the proxy and keep its telemetry off where it can be. */
export function runtimeEnvOverrides(proxyUrl: string, dataDirectory: string): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {};
  for (const name of STRIPPED_ENV) overrides[name] = undefined;
  Object.assign(overrides, {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    // Empty: nothing may bypass the proxy. (Loopback, the OAuth redirect listener, is not proxied by the
    // runtime: it is local to the machine.)
    NO_PROXY: '',
    no_proxy: '',
    // Telemetry: the SDK passes none unless the client is given `telemetry`, which KVox never does; these
    // are the documented, conventional switches, set so a user's shell cannot turn them on. The runtime has
    // a GitHub product-telemetry service with NO documented off switch (kvox-ai SPIKE.md section 5): the
    // allowlist is the control that works, and the README says so.
    COPILOT_OTEL_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true',
    DO_NOT_TRACK: '1',
    // Private state and no file logging outside the data directory.
    COPILOT_HOME: join(dataDirectory, 'home'),
  });
  return overrides;
}

/** Applies overrides to an environment copy. */
function merged(base: NodeJS.ProcessEnv, overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Starts the proxy and prepares the runtime environment. Call it lazily (the
 * first Copilot call or status check after the user opted in), never at start-up.
 */
export async function startCopilotRuntimeSandbox(options: CopilotSandboxOptions): Promise<CopilotRuntimeSandbox> {
  if (!options.dataDirectory) throw new Error('The Copilot sandbox needs the Copilot data directory');
  const log = (line: string): void => options.log(redactTokens(line));
  await mkdir(join(options.dataDirectory, 'home'), { recursive: true });
  const allowedHosts = options.allowedHosts ?? COPILOT_EGRESS_HOSTS;
  const proxy: EgressProxy = await startEgressProxy({ allowedHosts, log, connect: options.connect });
  const overrides = runtimeEnvOverrides(proxy.url, options.dataDirectory);
  const base = options.baseEnv ?? process.env;
  const env = merged(base, overrides);
  const saved = new Map<string, string | undefined>();
  const timeoutMs = options.stopTimeoutMs ?? 5_000;
  let stopping: Promise<void> | undefined;

  const sandbox: CopilotRuntimeSandbox = {
    env,
    overrides,
    proxyUrl: proxy.url,
    port: proxy.port,
    get refused() {
      return proxy.refused;
    },
    apply() {
      if (stopping) return;
      // Snapshot EVERY original first: on Windows `process.env` is case-insensitive, so HTTPS_PROXY and
      // https_proxy are one variable and the second read would otherwise see the first write.
      if (saved.size === 0) for (const name of Object.keys(overrides)) saved.set(name, process.env[name]);
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
    stop() {
      stopping ??= (async () => {
        running.delete(sandbox);
        try {
          if (options.stopRuntime) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
              options.stopRuntime().catch((error: unknown) => log(`copilot: the runtime did not stop cleanly: ${String(error)}`)),
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  log(`copilot: the runtime did not stop in ${timeoutMs} ms; killing it`);
                  resolve();
                }, timeoutMs);
              }),
            ]);
            if (timer) clearTimeout(timer);
          }
          // A runtime that hung (or was never asked to stop) must not outlive the sandbox.
          const killed = await reapRuntimeProcesses(options.reaper);
          if (killed.length > 0) log(`copilot: killed ${killed.length} runtime process(es) left behind`);
        } finally {
          await proxy.stop();
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
          saved.clear();
        }
      })();
      return stopping;
    },
  };
  running.add(sandbox);
  log(`copilot: egress proxy on 127.0.0.1:${proxy.port}, allowing ${allowedHosts.join(', ')}`);
  return sandbox;
}
