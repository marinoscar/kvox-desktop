import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { FILES_CHANNELS, MENU_CHANNELS, type FilesChangedEvent, type KvoxDesktopBridge, type KvoxDesktopFilesBridge } from '../shared/protocol';

// The renderer's one door to the shell: where the local server listens and the
// per-launch token, the native backup dialogs, the secret-storage status, the
// import (the dialog, and the paths of files dropped on the window) and the
// opt-in updates, the note libraries' file port (`files`), the theme choice (kept so the window is painted in it on the next launch), the shell's preferences (the rail), the two user-menu commands (data folder, About), and the three commands the application menu sends (the page
// gets the payload, never the IPC event).
// Nothing else of Node or Electron reaches the page.
function subscribe(channel: string, handler: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// The note libraries' file port (marinoscar/kvox-desktop#47). Folders are opaque ids; the main process
// validates every argument again and never answers an absolute path.
const files: KvoxDesktopFilesBridge = {
  pickFolder: () => ipcRenderer.invoke(FILES_CHANNELS.pickFolder),
  listFolders: () => ipcRenderer.invoke(FILES_CHANNELS.listFolders),
  forgetFolder: (folderId) => ipcRenderer.invoke(FILES_CHANNELS.forgetFolder, folderId),
  enumerate: (folderId, extensions) => ipcRenderer.invoke(FILES_CHANNELS.enumerate, folderId, Array.from(extensions)),
  enumerateNext: (cursor) => ipcRenderer.invoke(FILES_CHANNELS.enumerateNext, cursor),
  enumerateCancel: (cursor) => ipcRenderer.invoke(FILES_CHANNELS.enumerateCancel, cursor),
  hash: (folderId, path) => ipcRenderer.invoke(FILES_CHANNELS.hash, folderId, path),
  read: (folderId, path) => ipcRenderer.invoke(FILES_CHANNELS.read, folderId, path),
  getLibraryFolder: (libraryId) => ipcRenderer.invoke(FILES_CHANNELS.getLibraryFolder, libraryId),
  setLibraryFolder: (libraryId, folderId) => ipcRenderer.invoke(FILES_CHANNELS.setLibraryFolder, libraryId, folderId),
  watch: (folderId) => ipcRenderer.invoke(FILES_CHANNELS.watch, folderId),
  unwatch: (folderId) => ipcRenderer.invoke(FILES_CHANNELS.unwatch, folderId),
  onChanged: (handler) => subscribe(FILES_CHANNELS.changed, (payload) => handler(payload as FilesChangedEvent)),
};

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
  importFromDialog: () => ipcRenderer.invoke('kvox:import-choose'),
  // A dropped `File` carries its path only here; the page sees a name and bytes.
  importDropped: (files) =>
    ipcRenderer.invoke(
      'kvox:import-paths',
      Array.from(files, (file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
    ),
  themeMode: () => ipcRenderer.invoke('kvox:theme-mode'),
  setThemeMode: (mode) => ipcRenderer.invoke('kvox:set-theme-mode', mode),
  shellPreferences: () => ipcRenderer.invoke('kvox:shell-preferences'),
  setShellPreferences: (patch) => ipcRenderer.invoke('kvox:set-shell-preferences', patch),
  openDataFolder: () => ipcRenderer.invoke('kvox:open-data-folder'),
  showAbout: () => ipcRenderer.invoke('kvox:show-about'),
  // The main process opens only https://github.com/... (src/main/open-external.ts).
  openExternal: (url) => ipcRenderer.invoke('kvox:open-external', typeof url === 'string' ? url : ''),
  onMenuNavigate: (handler) => subscribe(MENU_CHANNELS.navigate, (payload) => handler(payload)),
  onMenuToggleTheme: (handler) => subscribe(MENU_CHANNELS.toggleTheme, () => handler()),
  onMenuImport: (handler) => subscribe(MENU_CHANNELS.importFiles, () => handler()),
  files,
};

contextBridge.exposeInMainWorld('kvoxDesktop', bridge);
