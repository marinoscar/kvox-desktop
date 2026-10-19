import { createLocalStorageShellPreferencesPort, type ShellPreferencesPort } from '@marinoscar/platform-web/shell/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import type { PlatformApiClient, PlatformWebHost } from '@marinoscar/platform-web/core';
import { createKvoxNavigation } from '@marinoscar/kvox-web/shell';

import type { DesktopConnection, KvoxDesktopBridge } from '../../shared/protocol';
import { useDesktopKnowledge } from './knowledge';
import { DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_SECTIONS } from './settings/sections';

// =============================================================================
// The shell's bindings (marinoscar/kvox-desktop#18)
// =============================================================================
//
// The shell itself (rail, app bar, user menu, bottom bar) is `KvoxAppShell` of
// `@marinoscar/kvox-web/shell`, the component KVox web renders. Only host facts
// are bound here:
//
//   navigation   which destinations Desktop lists, and where Settings leads
//   graph gate   the `graph` feature, read live from the connected-knowledge switch
//   preferences  where the rail's collapsed state is kept (the shell settings)
//   user menu    the two rows only a desktop has (rendered by App.tsx)
//   host         a PlatformWebHost whose viewer is the local user and whose API
//                has no server behind it
//
// Nothing here draws anything and nothing reads a breakpoint.
// =============================================================================

declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    /** Connected knowledge is switched on (the Desktop "Connected knowledge" card). */
    graph: true;
  }
}

// Knowledge, Review and Ask carry `feature: 'graph'`; the shell hides them unless this says on. It is a hook
// that reads the app's own context (never fetches): the switch is `useKnowledgeState`'s, so turning it on in
// Settings shows the three rows at once. Registered at module scope, before the first render.
registerSettingsFeature('graph', () => useDesktopKnowledge().graphEnabled === true);

/**
 * The rows: Notes, Knowledge, Review, Ask and Settings pinned at the foot. Templates is a Settings card
 * (`/settings/note-templates`), not a destination, so it is not listed. Declared once: the shell keys on it.
 */
export const { navigation: DESKTOP_NAVIGATION } = createKvoxNavigation({
  include: ['notes', 'graph', 'review', 'ask'],
  settingsPath: DESKTOP_SETTINGS_PATH,
  settingsSections: DESKTOP_SETTINGS_SECTIONS,
});

/** The bridge calls the rail preference needs; the shell's settings file is the store. */
type PreferencesBridge = Pick<KvoxDesktopBridge, 'shellPreferences' | 'setShellPreferences'>;

/**
 * The shell's preference port over the Desktop shell settings (`shell.railCollapsed` of
 * `<userData>/settings.json`, through IPC). Where the bridge has no such call (a test page), the platform's
 * localStorage port stands in.
 */
export function createDesktopShellPreferencesPort(bridge: Partial<PreferencesBridge> | undefined): ShellPreferencesPort {
  const { shellPreferences, setShellPreferences } = bridge ?? {};
  if (typeof shellPreferences !== 'function' || typeof setShellPreferences !== 'function') {
    return createLocalStorageShellPreferencesPort();
  }
  return {
    read: async () => ({ railCollapsed: (await shellPreferences.call(bridge)).railCollapsed }),
    write: async (patch) => {
      if (typeof patch.railCollapsed === 'boolean') await setShellPreferences.call(bridge, { railCollapsed: patch.railCollapsed });
    },
  };
}

/** The user menu rows of a desktop (the local mode adds neither sign-out nor an organization switcher). */
export function desktopUserMenuItems(bridge: Pick<KvoxDesktopBridge, 'openDataFolder' | 'showAbout'>) {
  return [
    { key: 'data-folder', label: 'Open data folder', onClick: () => void bridge.openDataFolder() },
    { key: 'about', label: 'About KVox', onClick: () => void bridge.showAbout() },
  ];
}

/** Desktop has no platform API: a packaged page that asked for one would be a bug, so it is refused loudly. */
const NO_PLATFORM_API: PlatformApiClient = (() => {
  const refuse = <T,>(path: string): Promise<T> => Promise.reject(new Error(`KVox Desktop has no platform API (${path})`));
  return {
    get: (path) => refuse(path),
    post: (path) => refuse(path),
    put: (path) => refuse(path),
    patch: (path) => refuse(path),
    delete: (path) => refuse(path),
  };
})();

/**
 * The platform host of the local user: the viewer is the connection's user and permissions (the same facts as
 * the identity provider), and the API is the refusing stub above.
 */
export function createDesktopPlatformHost(connection: DesktopConnection, graphEnabled: boolean | undefined): PlatformWebHost {
  const permissions = new Set(connection.permissions);
  return {
    api: NO_PLATFORM_API,
    viewer: {
      userId: connection.userId,
      hasPermission: (permission) => permissions.has(permission),
      isFeatureEnabled: (feature) => feature === 'graph' && graphEnabled === true,
    },
  };
}
