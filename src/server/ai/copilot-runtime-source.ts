import type { CopilotRuntimeDownload } from '@marinoscar/kvox-ai/copilot';

import { extractCopilotRuntimeTgz } from './copilot-runtime-extract.js';
import {
  COPILOT_RUNTIME_PINNED_VERSION,
  COPILOT_RUNTIME_SOURCES,
  type CopilotRuntimeSource,
} from './copilot-runtime-sources.js';

// =============================================================================
// Where the Copilot runtime download comes from (marinoscar/kvox-desktop#32)
// =============================================================================
//
// `prepareCopilotRuntime({ download })` needs a URL with a SHA-256 that WE pin
// (nobody publishes one). The pins are the generated table
// `copilot-runtime-sources.ts` (re-created by `scripts/pin-copilot-runtime.mjs`):
// the registry tarball of `@github/copilot-sdk-<platform>` at the exact version of
// the `@github/copilot-sdk` this build pins. This file only picks the row for the
// running platform and supplies the extractor. No Copilot mechanics: the download,
// its host checks, the checksum and the atomic install are `prepareCopilotRuntime`.
// =============================================================================

/** The download options of {@link CopilotRuntimeDownload} that this repository supplies. */
export type PinnedRuntimeDownload = Omit<CopilotRuntimeDownload, 'allowedHosts' | 'onProgress' | 'signal'>;

/** The SDK's platform name for a platform and architecture (`linux` is `linuxmusl` without glibc). */
export function sdkPlatformName(platform: string, arch: string, glibc: boolean): string {
  return `${platform === 'linux' && !glibc ? 'linuxmusl' : platform}-${arch}`;
}

/** The platform name of the running process (`linux-x64`, `linuxmusl-arm64`, `win32-x64`, ...). */
export function currentSdkPlatform(): string {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return sdkPlatformName(process.platform, process.arch, process.platform !== 'linux' || Boolean(header?.glibcVersionRuntime));
}

/** The pinned row for a platform, or `undefined` when GitHub ships no runtime for it. */
export function copilotRuntimeSourceFor(
  platform: string,
  table: Readonly<Record<string, CopilotRuntimeSource>> = COPILOT_RUNTIME_SOURCES,
): CopilotRuntimeSource | undefined {
  return Object.prototype.hasOwnProperty.call(table, platform) ? table[platform] : undefined;
}

/** The `download` options for one pinned source: its URL, digest, size cap and the strict `.tgz` extractor. */
export function downloadFromSource(source: CopilotRuntimeSource, version: string = COPILOT_RUNTIME_PINNED_VERSION): PinnedRuntimeDownload {
  return {
    url: source.url,
    sha256: source.sha256,
    version,
    // The pin is exact: a larger body is not the pinned file, whatever it hashes to.
    maxBytes: source.size,
    extract: (archivePath, destinationDirectory) => extractCopilotRuntimeTgz(archivePath, destinationDirectory, { launcher: source.launcher }),
  };
}

/** What the host knows about downloading on this platform. */
export type RuntimeDownloadPlan =
  | { supported: true; platform: string; download: PinnedRuntimeDownload }
  | { supported: false; platform: string; reason: string };

/** The pinned download for the running platform (or a clear reason there is none). */
export function planRuntimeDownload(
  platform: string = currentSdkPlatform(),
  table: Readonly<Record<string, CopilotRuntimeSource>> = COPILOT_RUNTIME_SOURCES,
): RuntimeDownloadPlan {
  const source = copilotRuntimeSourceFor(platform, table);
  if (!source) {
    return {
      supported: false,
      platform,
      reason: `GitHub publishes no Copilot runtime for ${platform}, so it cannot be downloaded on this computer.`,
    };
  }
  return { supported: true, platform, download: downloadFromSource(source) };
}
