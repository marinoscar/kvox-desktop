import { contextBridge, ipcRenderer } from 'electron';

import type { KvoxDesktopBridge } from '../shared/protocol';

// The renderer's one door to the shell: where the local server listens and the
// per-launch token, the native backup dialogs and the secret-storage status.
// Nothing else of Node or Electron reaches the page.
const bridge: KvoxDesktopBridge = {
  connection: () => ipcRenderer.invoke('kvox:connection'),
  dataFolder: () => ipcRenderer.invoke('kvox:data-folder'),
  chooseBackupTarget: () => ipcRenderer.invoke('kvox:choose-backup-target'),
  chooseBackupSource: () => ipcRenderer.invoke('kvox:choose-backup-source'),
  secretStorage: () => ipcRenderer.invoke('kvox:secret-storage'),
  acceptPlaintextSecrets: (accepted) => ipcRenderer.invoke('kvox:accept-plaintext-secrets', accepted === true),
};

contextBridge.exposeInMainWorld('kvoxDesktop', bridge);
