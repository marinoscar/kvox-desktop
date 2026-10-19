import { existsSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Where a bundled Copilot runtime would be (marinoscar/kvox-desktop#23)
// =============================================================================
//
// The default installer does NOT contain the Copilot runtime: it is downloaded
// on the first opt-in (`prepareCopilotRuntime({ download })`) into
// `<userData>/copilot/runtime/<version>`. The optional "with-copilot" flavour
// (electron-builder.with-copilot.yml, README "Packaging") ships the launcher and
// its sibling `runtime.node` as an `extraResource` in `<resources>/copilot/`,
// outside app.asar (a file inside an asar archive cannot be executed).
//
// This is the ONE place that knows the layout. The host passes the result as the
// `bundledRuntimePath` option of `prepareCopilotRuntime`: `undefined` (the
// default installer) selects the download path, a path selects the bundled one.
// =============================================================================

/** The folder under `process.resourcesPath` the with-copilot flavour fills. */
export const BUNDLED_RUNTIME_FOLDER = 'copilot';

/** The launcher's file name on a platform. */
export function runtimeLauncherName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
}

/**
 * The launcher of the bundled runtime, or `undefined` when this build does not
 * carry one (the default installer, and a development checkout).
 */
export function bundledRuntimePath(
  resourcesPath: string | undefined = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!resourcesPath) return undefined;
  const launcher = join(resourcesPath, BUNDLED_RUNTIME_FOLDER, runtimeLauncherName(platform));
  return exists(launcher) ? launcher : undefined;
}
