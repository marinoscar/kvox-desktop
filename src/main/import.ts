import { isAbsolute } from 'node:path';

import { dialog, ipcMain, type BrowserWindow } from 'electron';

import type { DesktopConnection, ImportOutcome } from '../shared/protocol';
import { importLocalFiles } from './import-file';

// =============================================================================
// "Import…" and drag and drop (marinoscar/kvox#585)
// =============================================================================
//
// Two doors to the same import (`import-file.ts`): the native open dialog, and
// files dropped on the window (the preload turns each dropped `File` into its
// path with `webUtils.getPathForFile`). Files are imported one after the other,
// so a folder of transcripts does not hit the single-writer database at once.
// Note documents (Markdown, text, PDF, Word, PowerPoint) go into one import
// batch per drop or dialog, whose progress page the window then opens
// (marinoscar/kvox-desktop#47).
//
// The window never reads a file itself: it gets back what each import created
// (or the server's refusal) and opens it.
// =============================================================================

/** What the dialog offers first; "All files" stays available (the content decides, not the name). */
const FILTERS = [
  { name: 'Transcripts, notes and documents', extensions: ['pdf', 'docx', 'pptx', 'json', 'md', 'markdown', 'txt'] },
  { name: 'All files', extensions: ['*'] },
];

/**
 * The most files one drop or one dialog imports. Note documents stream into one batch, so a large folder's
 * worth is fine; a folder kept in sync belongs in a note library (Notes > Libraries).
 */
export const MAX_IMPORT_FILES = 2000;

/** Registers the two import handlers. */
export function registerImportIpc(options: {
  window: () => BrowserWindow | undefined;
  connection: () => Promise<DesktopConnection> | undefined;
  log: (line: string) => void;
}): void {
  const importAll = async (paths: readonly string[]): Promise<ImportOutcome[]> => {
    const connection = await options.connection();
    if (!connection) throw new Error('The local server is not running.');
    return importLocalFiles(paths.slice(0, MAX_IMPORT_FILES), { connection, log: options.log });
  };

  ipcMain.handle('kvox:import-choose', async () => {
    const window = options.window();
    const dialogOptions = {
      title: 'Import',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: FILTERS,
    };
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return importAll(result.filePaths);
  });

  ipcMain.handle('kvox:import-paths', async (_event, paths: unknown) => {
    const valid = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string' && isAbsolute(path)) : [];
    return importAll(valid);
  });
}
