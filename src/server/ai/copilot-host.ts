import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CopilotRuntimeDownload,
  CopilotTransport,
  PreparedCopilotRuntime,
} from '@marinoscar/kvox-ai/copilot';

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
}

/** Options of {@link createDefaultCopilotHost}. */
export interface DefaultCopilotHostOptions {
  dataDirectory: string;
  /** The launcher the app ships; default {@link findBundledRuntime}. */
  bundledRuntimePath?: string | null;
  /**
   * Where the opt-in download comes from (hosts, URL and pinned SHA-256, or a manifest, and the
   * archive extractor). Absent: there is no download, and the download action answers 409
   * `runtime_download_unavailable`. #23 supplies it.
   */
  download?: Omit<CopilotRuntimeDownload, 'onProgress' | 'signal'>;
}

/** The runtime launcher's file name on this platform. */
function launcherName(): string {
  return process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
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
 * The runtime launcher that ships with the app, if any: `<resources>/copilot/copilot-runtime`
 * in a packaged app (#23 puts it there), else the one inside the installed
 * `@github/copilot-sdk-<platform>` package (a development checkout). `null` when neither exists.
 */
export function findBundledRuntime(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates: string[] = [];
  if (resources) candidates.push(join(resources, 'copilot', launcherName()));
  const platform = sdkPlatform();
  try {
    const manifest = require.resolve(`@github/copilot-sdk-${platform}/package.json`);
    candidates.push(join(manifest, '..', 'prebuilds', platform, launcherName()));
  } catch {
    // The platform package is not installed.
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** The in-process host: `prepareCopilotRuntime` and `createSdkCopilotTransport`. */
export function createDefaultCopilotHost(options: DefaultCopilotHostOptions): CopilotHost {
  return {
    dataDirectory: options.dataDirectory,
    canDownload: options.download !== undefined,
    async prepareRuntime(request) {
      const { prepareCopilotRuntime } = await import('@marinoscar/kvox-ai/copilot');
      const bundled = options.bundledRuntimePath === undefined ? findBundledRuntime() : options.bundledRuntimePath;
      if (request.download && !options.download) {
        throw new CopilotDownloadUnavailableError();
      }
      return prepareCopilotRuntime({
        dataDirectory: request.dataDirectory,
        // A bundled launcher is always preferred; the download only when asked for.
        ...(bundled ? { bundledRuntimePath: bundled } : {}),
        ...(request.download && !bundled && options.download
          ? {
              download: {
                ...options.download,
                ...(request.onProgress ? { onProgress: request.onProgress } : {}),
                ...(request.signal ? { signal: request.signal } : {}),
              },
            }
          : {}),
      });
    },
    async createTransport(runtime) {
      const { createSdkCopilotTransport } = await import('@marinoscar/kvox-ai/copilot');
      // The SDK honours COPILOT_CLI_PATH for the runtime launcher (read in its client).
      process.env.COPILOT_CLI_PATH = runtime.runtimePath;
      return createSdkCopilotTransport({ baseDirectory: runtime.baseDirectory, workingDirectory: runtime.workingDirectory });
    },
  };
}
