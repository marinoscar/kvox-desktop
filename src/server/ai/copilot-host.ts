import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CopilotRuntimeDownload,
  CopilotTransport,
  PreparedCopilotRuntime,
} from '@marinoscar/kvox-ai/copilot';

import type { DataFolder } from '../data-folder.js';
import { removeCopilotData, type RemovedCopilotData } from './copilot-data.js';
import { bundledRuntimePath } from './copilot-runtime-location.js';
import { COPILOT_RUNTIME_DOWNLOAD_HOSTS, startCopilotRuntimeSandbox } from './copilot-sandbox.js';

// =============================================================================
// The Copilot host seam (marinoscar/kvox-desktop#21; plugged into by #23)
// =============================================================================
//
// Everything about HOW Desktop gets a Copilot runtime and a transport sits behind
// this one interface, so the lifecycle code (`copilot-service.ts`) never changes
// when the runtime's packaging, its download source or the out-of-process egress
// proxy does (marinoscar/kvox-desktop#23):
//
//   prepareRuntime   resolve the runtime: the bundled launcher first, else the
//                    opt-in download (only when `request.download` is true).
//   createTransport  build the CopilotTransport over a prepared runtime.
//
// The defaults below do the in-process thing: `prepareCopilotRuntime` and
// `createSdkCopilotTransport` of `@marinoscar/kvox-ai/copilot`. They hold no
// Copilot mechanics of their own. ⚠ The module is imported lazily (it is only
// reached when Copilot is on), so the SDK and the adapter code are not loaded
// otherwise.
// =============================================================================

/** Thrown by a host that has no download source configured. */
export class CopilotDownloadUnavailableError extends Error {
  constructor() {
    super('No Copilot runtime download is configured for this build.');
    this.name = 'CopilotDownloadUnavailableError';
  }
}

/** What {@link CopilotRuntimeProvider} is asked for. */
export interface CopilotRuntimeRequest {
  /** `<userData>/copilot`: Copilot's private home, empty working directory and downloaded runtimes. */
  dataDirectory: string;
  /** True only for the user's explicit "download the runtime" action; false at every ordinary start. */
  download: boolean;
  /** Progress of a download (`received` bytes of `total`, when known). */
  onProgress?(progress: { received: number; total?: number }): void;
  /** Cancels a download. */
  signal?: AbortSignal;
}

/**
 * The seam #23 plugs the runtime lifecycle into: resolves (and, on request, downloads
 * and verifies) the Copilot runtime. Rejects with an `AiError` whose `details.check`
 * is `runtime_missing` when there is none yet.
 */
export type CopilotRuntimeProvider = (request: CopilotRuntimeRequest) => Promise<PreparedCopilotRuntime>;

/** Builds the transport over a prepared runtime. */
export type CopilotTransportFactory = (runtime: PreparedCopilotRuntime) => Promise<CopilotTransport> | CopilotTransport;

/** The Copilot host: where the data lives and how the runtime and transport are made. */
export interface CopilotHost {
  /** `<userData>/copilot`. */
  readonly dataDirectory: string;
  /** Whether the opt-in download can work at all (a download source is configured). */
  readonly canDownload: boolean;
  readonly prepareRuntime: CopilotRuntimeProvider;
  readonly createTransport: CopilotTransportFactory;
  /**
   * Deletes the Copilot directory's contents ("Remove Copilot data"; the downloaded runtime stays
   * unless asked). Only called with the runtime stopped. Absent: nothing to delete.
   */
  removeData?(options: { includeRuntime?: boolean }): Promise<RemovedCopilotData>;
}

/** Options of {@link createDefaultCopilotHost}. */
export interface DefaultCopilotHostOptions {
  /** The user data folder: `folder.copilot` is Copilot's private directory (never in a backup). */
  folder: DataFolder;
  /** One line per event (the sandbox's proxy and cleanup lines; already token-redacted). */
  log: (line: string) => void;
  /**
   * The launcher the app ships. Default: {@link bundledRuntimePath} (the "with-copilot" flavour's
   * `resources/copilot/`), else {@link findInstalledSdkRuntime} (a development checkout).
   */
  bundledRuntimePath?: string | null;
  /**
   * Where the opt-in download comes from: `url` with a pinned `sha256` (or a `manifestUrl`), and the
   * archive `extract` hook. `allowedHosts` defaults to {@link COPILOT_RUNTIME_DOWNLOAD_HOSTS}.
   * Absent: there is no download, and the download action answers 409 `runtime_download_unavailable`.
   */
  download?: Omit<CopilotRuntimeDownload, 'onProgress' | 'signal' | 'allowedHosts'> & { allowedHosts?: readonly string[] };
}

/** The SDK's platform package suffix (`linux-x64`, `linuxmusl-x64`, `win32-arm64`, ...). */
function sdkPlatform(): string {
  let platform: string = process.platform;
  if (platform === 'linux') {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (!header?.glibcVersionRuntime) platform = 'linuxmusl';
  }
  return `${platform}-${process.arch}`;
}

/**
 * The runtime launcher inside the installed `@github/copilot-sdk-<platform>` package: what a
 * development checkout (`npm install`) has. The installer excludes these packages (#23), so a
 * packaged app finds none. `null` when the package is not installed.
 */
export function findInstalledSdkRuntime(): string | null {
  const platform = sdkPlatform();
  try {
    const manifest = require.resolve(`@github/copilot-sdk-${platform}/package.json`);
    const launcher = join(manifest, '..', 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
    return existsSync(launcher) ? launcher : null;
  } catch {
    return null;
  }
}

/** The in-process host: `prepareCopilotRuntime`, and `createSdkCopilotTransport` behind the egress sandbox. */
export function createDefaultCopilotHost(options: DefaultCopilotHostOptions): CopilotHost {
  const dataDirectory = options.folder.copilot;
  const canDownload = options.download?.url !== undefined || options.download?.manifestUrl !== undefined;
  return {
    dataDirectory,
    canDownload,
    async prepareRuntime(request) {
      const { prepareCopilotRuntime } = await import('@marinoscar/kvox-ai/copilot');
      const bundled = options.bundledRuntimePath === undefined ? (bundledRuntimePath() ?? findInstalledSdkRuntime()) : options.bundledRuntimePath;
      if (request.download && !canDownload) throw new CopilotDownloadUnavailableError();
      return prepareCopilotRuntime({
        dataDirectory: request.dataDirectory,
        // A bundled launcher is always preferred (and never downloaded over); the download only when asked for.
        ...(bundled ? { bundledRuntimePath: bundled } : {}),
        ...(request.download && !bundled && options.download
          ? {
              download: {
                ...options.download,
                allowedHosts: options.download.allowedHosts ?? COPILOT_RUNTIME_DOWNLOAD_HOSTS,
                ...(request.onProgress ? { onProgress: request.onProgress } : {}),
                ...(request.signal ? { signal: request.signal } : {}),
              },
            }
          : {}),
      });
    },
    async createTransport(runtime) {
      const { createSdkCopilotTransport } = await import('@marinoscar/kvox-ai/copilot');
      // The runtime child process is forced through the allowlisting proxy. The SDK spawns it with a
      // copy of THIS process's environment (the transport has no `env` option), so the sandbox's
      // variables go in BEFORE the transport starts it, and come out when the sandbox stops.
      let transport: CopilotTransport | undefined;
      const sandbox = await startCopilotRuntimeSandbox({
        dataDirectory,
        log: options.log,
        stopRuntime: async () => {
          await transport?.stop?.();
        },
      });
      sandbox.apply();
      // The SDK honours COPILOT_CLI_PATH for the runtime launcher (read in its client).
      process.env.COPILOT_CLI_PATH = runtime.runtimePath;
      const created = createSdkCopilotTransport({ baseDirectory: runtime.baseDirectory, workingDirectory: runtime.workingDirectory });
      transport = created;
      // Stopping the transport stops the sandbox: the runtime, any straggler, the proxy and the environment.
      return { ...created, stop: () => sandbox.stop() };
    },
    removeData: (removeOptions) => removeCopilotData(options.folder, removeOptions),
  };
}
