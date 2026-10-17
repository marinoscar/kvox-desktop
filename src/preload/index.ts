import { contextBridge, ipcRenderer } from 'electron';

import type { KvoxDesktopBridge } from '../shared/protocol';

// The renderer's one door to the shell: where the local server listens and the
// per-launch token, the native backup dialogs, the secret-storage status and
// the opt-in updates.
// Nothing else of Node or Electron reaches the page.
const bridge: KvoxDesktopBridge = {
  connection: () => ipcRenderer.invoke('kvox:connection'),
  dataFolder: () => ipcRenderer.invoke('kvox:data-folder'),
  chooseBackupTarget: () => ipcRenderer.invoke('kvox:choose-backup-target'),
  chooseBackupSource: () => ipcRenderer.invoke('kvox:choose-backup-source'),
  secretStorage: () => ipcRenderer.invoke('kvox:secret-storage'),
  acceptPlaintextSecrets: (accepted) => ipcRenderer.invoke('kvox:accept-plaintext-secrets', accepted === true),
  updates: () => ipcRenderer.invoke('kvox:updates'),
  setUpdatesEnabled: (enabled) => ipcRenderer.invoke('kvox:set-updates-enabled', enabled === true),
  installUpdate: () => ipcRenderer.invoke('kvox:install-update'),
};

contextBridge.exposeInMainWorld('kvoxDesktop', bridge);
