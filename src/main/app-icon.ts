import { join } from 'node:path';

// =============================================================================
// Where the window's icon lives (marinoscar/kvox-desktop#20)
// =============================================================================
//
// Windows and Linux show the BrowserWindow's `icon` in the taskbar and the
// alt-tab switcher (Linux has no other source: the window of an AppImage or a
// dev run has no desktop entry). macOS takes the Dock icon from the bundle's
// `.icns`, so no window icon is set there.
//
// Packaged, electron-builder copies the files to the resources folder
// (`extraResources` in electron-builder.yml); in development they are read from
// `build/`, the folder `npm run icons` writes.
// =============================================================================

export interface AppIconEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** `app.getAppPath()`: the repository root in development. */
  appPath: string;
}

/** The icon file for the window, or `undefined` where the OS takes it from the bundle. */
export function windowIconPath(env: AppIconEnv): string | undefined {
  if (env.platform === 'darwin') return undefined;
  const folder = env.isPackaged ? env.resourcesPath : join(env.appPath, 'build');
  if (env.platform === 'win32') return join(folder, 'icon.ico');
  return join(folder, env.isPackaged ? 'icon.png' : join('linux', 'icon.png'));
}

/** The PNG the About panel shows (all platforms). */
export function aboutIconPath(env: Pick<AppIconEnv, 'isPackaged' | 'resourcesPath' | 'appPath'>): string {
  return env.isPackaged ? join(env.resourcesPath, 'icon.png') : join(env.appPath, 'build', 'linux', 'icon.png');
}
