import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Menu, app, dialog, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

import { MENU_CHANNELS } from '../shared/protocol';
import { aboutIconPath } from './app-icon';

// =============================================================================
// The KVox application menu (marinoscar/kvox-desktop#20)
// =============================================================================
//
// Electron's default menu (File / Edit / View / Window with Force Reload and
// Toggle Developer Tools in production, and links to electronjs.org) is replaced
// by KVox's own, installed in `app.whenReady`.
//
//   File    New note, Import…, Settings, Quit (macOS: Settings and Quit are in
//           the KVox menu, where Mac users look for them)
//   Edit    the standard roles
//   View    Toggle light/dark, zoom, full screen; Reload and Developer Tools
//           ONLY when the app is not packaged
//   Window  minimize and close (macOS: the standard window menu)
//   Help    About KVox, Open data folder, View licences
//
// NO ITEM OPENS A REMOTE URL (ADR-0004: the only traffic off the device is the
// configured AI provider and the opt-in update check). Help opens the user data
// folder and a local file; About is a panel. tests/unit/menu.test.ts walks the
// template and this file for anything that looks like a link.
//
// The menu only sends the window a command (`MENU_CHANNELS`); the renderer
// validates it and does the work (navigate, switch theme, run the import).
// =============================================================================

export const PRODUCT_NAME = 'KVox';

/** What the template needs from the outside, so it can be built and walked without Electron. */
export interface MenuActions {
  navigate(path: string): void;
  importFiles(): void;
  toggleTheme(): void;
  showAbout(): void;
  openDataFolder(): void;
  openLicences(): void;
}

export interface MenuEnv {
  platform: NodeJS.Platform;
  /** `app.isPackaged`: Reload and Developer Tools exist only when this is false. */
  isPackaged: boolean;
  actions: MenuActions;
}

/** The menu bar as a template. */
export function buildMenuTemplate({ platform, isPackaged, actions }: MenuEnv): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const settings: MenuItemConstructorOptions = {
    label: mac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => actions.navigate('/settings'),
  };
  const about: MenuItemConstructorOptions = { label: `About ${PRODUCT_NAME}`, click: () => actions.showAbout() };

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: PRODUCT_NAME,
          submenu: [
            about,
            { type: 'separator' },
            settings,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: `Quit ${PRODUCT_NAME}` },
          ],
        },
      ]
    : [];

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New note', accelerator: 'CmdOrCtrl+N', click: () => actions.navigate('/notes/new') },
      { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: () => actions.importFiles() },
      ...(mac ? [] : ([{ type: 'separator' }, settings, { type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const developer: MenuItemConstructorOptions[] = isPackaged
    ? []
    : [{ type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }];
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { label: 'Toggle light/dark', accelerator: 'CmdOrCtrl+Shift+L', click: () => actions.toggleTheme() },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Actual size' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...developer,
    ],
  };

  const windowMenu: MenuItemConstructorOptions = mac
    ? { role: 'windowMenu' }
    : { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] };

  const help: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      ...(mac ? [] : [about, { type: 'separator' } as MenuItemConstructorOptions]),
      { label: 'Open data folder', click: () => actions.openDataFolder() },
      { label: 'View licences', click: () => actions.openLicences() },
    ],
  };

  return [...appMenu, file, edit, view, windowMenu, help];
}

/** The `@marinoscar/*` versions the app was built with, from its own package.json (exact pins). */
export function packageVersions(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): Array<[string, string]> {
  return Object.entries({ ...pkg.devDependencies, ...pkg.dependencies })
    .filter(([name]) => name.startsWith('@marinoscar/'))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The lines the About panel shows below the version. */
export function aboutDetails(
  versions: { electron: string; chrome: string; node: string },
  packages: Array<[string, string]>,
): string {
  const lines = [`Electron ${versions.electron}`, `Chromium ${versions.chrome}`, `Node.js ${versions.node}`];
  if (packages.length > 0) lines.push('', ...packages.map(([name, version]) => `${name} ${version}`));
  return lines.join('\n');
}

function readPackageJson(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as ReturnType<typeof readPackageJson>;
  } catch {
    return {};
  }
}

/** Installs the menu on `app.whenReady`'s tick; `window` is the window the commands go to. Returns the menu's actions. */
export function installApplicationMenu(options: { window: () => BrowserWindow | undefined; log: (line: string) => void }): MenuActions {
  const env = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() };
  const send = (channel: string, payload?: string): void => {
    const target = options.window()?.webContents;
    if (!target || target.isDestroyed()) return;
    if (payload === undefined) target.send(channel);
    else target.send(channel, payload);
  };
  const details = aboutDetails(process.versions as unknown as { electron: string; chrome: string; node: string }, packageVersions(readPackageJson()));
  const copyright = 'Copyright © 2026 Oscar Marin';

  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    version: process.versions.electron,
    copyright,
    credits: details,
    iconPath: aboutIconPath(env),
  });

  const actions: MenuActions = {
    navigate: (path) => send(MENU_CHANNELS.navigate, path),
    importFiles: () => send(MENU_CHANNELS.importFiles),
    toggleTheme: () => send(MENU_CHANNELS.toggleTheme),
    // macOS and Linux have an About panel (app.setAboutPanelOptions above); Windows gets a message box.
    showAbout: () => {
      if (process.platform !== 'win32') {
        app.showAboutPanel();
        return;
      }
      const window = options.window();
      const box = {
        type: 'info' as const,
        title: `About ${PRODUCT_NAME}`,
        message: `${PRODUCT_NAME} ${app.getVersion()}`,
        detail: `${copyright}\n\n${details}`,
        icon: aboutIconPath(env),
        buttons: ['OK'],
      };
      void (window ? dialog.showMessageBox(window, box) : dialog.showMessageBox(box));
    },
    openDataFolder: () => {
      void shell.openPath(app.getPath('userData')).then((failure) => {
        if (failure) options.log(`menu: the data folder did not open: ${failure}`);
      });
    },
    openLicences: () => {
      const file = app.isPackaged ? join(process.resourcesPath, 'LICENSE.txt') : join(app.getAppPath(), 'LICENSE');
      void shell.openPath(file).then((failure) => {
        if (failure) options.log(`menu: the licence file did not open: ${failure}`);
      });
    },
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ platform: process.platform, isPackaged: app.isPackaged, actions })));
  // The same actions back the renderer's user menu ("Open data folder", "About KVox"): one implementation of each.
  return actions;
}
