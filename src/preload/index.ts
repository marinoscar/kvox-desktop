import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopConnection } from '../shared/protocol';

// The renderer's one door to the shell: where the local server listens and the
// per-launch token. Nothing else of Node or Electron reaches the page.
contextBridge.exposeInMainWorld('kvoxDesktop', {
  connection: (): Promise<DesktopConnection> => ipcRenderer.invoke('kvox:connection'),
});
