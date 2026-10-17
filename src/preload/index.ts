import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { KvoxDesktopBridge } from '../shared/protocol';

// The renderer's one door to the shell: where the local server listens and the
// per-launch token, the native backup dialogs, the secret-storage status and the
// import (the dialog, and the paths of files dropped on the window).
// Nothing else of Node or Electron reaches the page.
const bridge: KvoxDesktopBridge = {
  connection: () => ipcRenderer.invoke('kvox:connection'),
  dataFolder: () => ipcRenderer.invoke('kvox:data-folder'),
  chooseBackupTarget: () => ipcRenderer.invoke('kvox:choose-backup-target'),
  chooseBackupSource: () => ipcRenderer.invoke('kvox:choose-backup-source'),
  secretStorage: () => ipcRenderer.invoke('kvox:secret-storage'),
  acceptPlaintextSecrets: (accepted) => ipcRenderer.invoke('kvox:accept-plaintext-secrets', accepted === true),
  importFromDialog: () => ipcRenderer.invoke('kvox:import-choose'),
  // A dropped `File` carries its path only here; the page sees a name and bytes.
  importDropped: (files) =>
    ipcRenderer.invoke(
      'kvox:import-paths',
      Array.from(files, (file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
    ),
};

contextBridge.exposeInMainWorld('kvoxDesktop', bridge);
