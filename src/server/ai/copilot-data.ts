import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { DataFolder } from '../data-folder.js';

// =============================================================================
// "Remove Copilot data" (marinoscar/kvox-desktop#23)
// =============================================================================
//
// `<userData>/copilot` holds, besides the downloaded runtime, the runtime's own
// state (`home/`: sessions, sign-in material) and its empty working directory
// (`work/`). When the user turns Copilot off and confirms, `home/` and `work/`
// go (and anything else the runtime left there); the downloaded runtime
// (`runtime/`, 130 MB or more) stays unless the user also asks for it to go, so
// turning Copilot on again does not download it twice.
//
// Stop the sandbox FIRST (`CopilotRuntimeSandbox.stop()`): a running runtime
// holds files open (and on Windows a file in use cannot be deleted).
// =============================================================================

/** The directory of downloaded runtimes under the Copilot directory. */
export const COPILOT_RUNTIME_DIRECTORY = 'runtime';

/** What {@link removeCopilotData} removed. */
export interface RemovedCopilotData {
  /** Names directly under the Copilot directory that were deleted. */
  removed: string[];
  /** True when the downloaded runtime was kept. */
  keptRuntime: boolean;
}

/**
 * Deletes the Copilot directory's contents, except the downloaded runtime unless
 * `includeRuntime`. Refuses a directory that is not the data folder's `copilot`.
 */
export async function removeCopilotData(folder: DataFolder, options: { includeRuntime?: boolean } = {}): Promise<RemovedCopilotData> {
  const root = folder.copilot;
  if (basename(root) !== 'copilot' || dirname(root) !== folder.root) {
    throw new Error('Refusing to remove a directory that is not the Copilot data directory');
  }
  const entries = await readdir(root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of entries) {
    if (name === COPILOT_RUNTIME_DIRECTORY && !options.includeRuntime) continue;
    await rm(join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    removed.push(name);
  }
  if (options.includeRuntime) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return { removed: removed.sort(), keptRuntime: !options.includeRuntime && entries.includes(COPILOT_RUNTIME_DIRECTORY) };
}
