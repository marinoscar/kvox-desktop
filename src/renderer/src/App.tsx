import { Suspense, useMemo, type ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { KvoxWebHostProvider } from '@marinoscar/kvox-web/core/headless';
import { KvoxAppShell, renderKvoxRoutes } from '@marinoscar/kvox-web/shell';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { LocalIdentityProvider } from '@marinoscar/platform-web/identity/headless';
import { ShellPreferencesProvider } from '@marinoscar/platform-web/shell/headless';

import type { DesktopConnection } from '../../shared/protocol';
import { createDesktopHost } from './host';
import { ImportProvider } from './import/ImportProvider';
import { MenuCommands } from './MenuCommands';
import { DesktopKnowledgeProvider, useKnowledgeState } from './knowledge';
import { desktopKnowledgeRoutes, desktopNotesRoutes } from './routes';
import { renderDesktopSettingsRoutes } from './settings/routes';
import { DESKTOP_NAVIGATION, createDesktopPlatformHost, createDesktopShellPreferencesPort, desktopUserMenuItems } from './shell';
import { DesktopThemeRoot } from './theme';

// The renderer, as bindings (marinoscar/kvox-desktop#18). The rail, the app bar (the KVox mark and name, the
// theme toggle, the user menu), the bottom bar of a small window and the page frame are `KvoxAppShell` of
// `@marinoscar/kvox-web/shell`, the component KVox web renders; this file supplies host facts only:
//
//   identity     the local user from the connection (no sign-in, no organization switcher)
//   preferences  the rail's collapsed state, kept in the shell settings (shell.tsx)
//   navigation   Notes, Knowledge, Review, Ask and Settings (shell.tsx); the graph rows follow the
//                connected-knowledge switch, live
//   user menu    "Open data folder" and "About KVox"
//   routes       the slices' route data under the shell, the import (the "Import…" action and a
//                window-wide drop target, marinoscar/kvox#585) and Settings (the platform's SettingsHub
//                and one page per card of `settings/sections.tsx`; Note Templates is one of them)
//
// With connected knowledge switched off (`ai.graphEnabled`, marinoscar/kvox#620) the knowledge routes are not
// mounted; the graph itself is kept and comes back when the switch is turned on.
//
// The look is the brand package's, applied by the platform's ShellRoot (`DesktopThemeRoot`, theme.tsx); the
// shell's own toggle switches light / dark / system, as does the View > Toggle light/dark menu item.

const LOADING = (
  <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
    <CircularProgress aria-label="Loading" />
  </Box>
);

export function App({ connection }: { connection: DesktopConnection }): ReactElement {
  const knowledge = useKnowledgeState(connection);
  const { graphEnabled } = knowledge;
  const host = useMemo(() => createDesktopHost(connection, graphEnabled), [connection, graphEnabled]);
  const platformHost = useMemo(() => createDesktopPlatformHost(connection, graphEnabled), [connection, graphEnabled]);
  const preferences = useMemo(() => createDesktopShellPreferencesPort(window.kvoxDesktop), []);
  const userMenuItems = useMemo(() => desktopUserMenuItems(window.kvoxDesktop), []);
  return (
    <DesktopThemeRoot>
      <LocalIdentityProvider userId={connection.userId} displayName={connection.displayName ?? 'You'} permissions={connection.permissions}>
        <PlatformHostProvider host={platformHost}>
          <ShellPreferencesProvider port={preferences}>
            <DesktopKnowledgeProvider value={knowledge}>
              <KvoxWebHostProvider host={host}>
                <HashRouter>
                  <ImportProvider>
                    <MenuCommands />
                    <Suspense fallback={LOADING}>
                      <Routes>
                        <Route element={<KvoxAppShell navigation={DESKTOP_NAVIGATION} actions={null} userMenuItems={userMenuItems} />}>
                          {/* The routes wait for the switch, so a knowledge link is not sent to /notes while it loads. */}
                          {graphEnabled === undefined ? (
                            <Route path="*" element={LOADING} />
                          ) : (
                            [
                              <Route key="/" path="/" element={<Navigate to="/notes" replace />} />,
                              ...renderKvoxRoutes(desktopNotesRoutes),
                              ...(graphEnabled ? renderKvoxRoutes(desktopKnowledgeRoutes) : []),
                              ...renderDesktopSettingsRoutes(),
                              <Route key="*" path="*" element={<Navigate to="/notes" replace />} />,
                            ]
                          )}
                        </Route>
                      </Routes>
                    </Suspense>
                  </ImportProvider>
                </HashRouter>
              </KvoxWebHostProvider>
            </DesktopKnowledgeProvider>
          </ShellPreferencesProvider>
        </PlatformHostProvider>
      </LocalIdentityProvider>
    </DesktopThemeRoot>
  );
}
