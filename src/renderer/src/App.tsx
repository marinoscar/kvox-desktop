import { Suspense, useMemo } from 'react';
import { HashRouter, Link as RouterLink, Navigate, Route, Routes } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';

import { KvoxWebHostProvider } from '@marinoscar/kvox-web/core/headless';

import type { DesktopConnection } from '../../shared/protocol';
import { AskNavButton } from './AskNavButton';
import { createDesktopHost } from './host';
import { ImportProvider } from './import/ImportProvider';
import { MenuCommands } from './MenuCommands';
import { DesktopKnowledgeProvider, useKnowledgeState } from './knowledge';
import { desktopKnowledgeRoutes, desktopNotesRoutes, renderKvoxRoutes } from './routes';
import { renderDesktopSettingsRoutes } from './settings/routes';
import { DesktopThemeRoot } from './theme';
import { ThemeModeButton } from './ThemeModeButton';

// The shell: one bar, the notes destination, the notes routes, the import
// (the "Import…" action and a window-wide drop target, marinoscar/kvox#585),
// the knowledge destinations (Knowledge: the graph index, entity pages, the
// explorer and the overview; Review: the proposals waiting; Ask; marinoscar/kvox#586)
// and Settings (the hub and one page per card of `settings/sections.tsx`, the
// platform's `SettingsHub`; Note Templates is one of its cards). With connected
// knowledge switched off (`ai.graphEnabled`, the "Connected knowledge" card,
// marinoscar/kvox#620) the knowledge destinations and routes are not mounted;
// the graph itself is kept and comes back when the switch is turned on.

// The look is the brand package's, applied by the platform's ShellRoot (`DesktopThemeRoot`, theme.tsx):
// the light / dark / system choice is its `useShellTheme`, switched by the app bar's temporary button
// and by the View > Toggle light/dark menu item (MenuCommands).

export function App({ connection }: { connection: DesktopConnection }) {
  const knowledge = useKnowledgeState(connection);
  const { graphEnabled } = knowledge;
  const host = useMemo(() => createDesktopHost(connection, graphEnabled), [connection, graphEnabled]);
  const loading = (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress aria-label="Loading" />
    </Box>
  );
  return (
    <DesktopThemeRoot>
      <DesktopKnowledgeProvider value={knowledge}>
        <KvoxWebHostProvider host={host}>
          <HashRouter>
            <ImportProvider>
              <MenuCommands />
              {/* The page's paper and text from the theme (the grey `default` colour is MUI's, not KVox's); #18 replaces the bar. */}
              <AppBar position="sticky" color="default" elevation={0} sx={{ bgcolor: 'background.paper', color: 'text.primary' }}>
                <Toolbar sx={{ gap: 2 }}>
                  <Typography variant="h6" component="span">
                    KVox
                  </Typography>
                  <Button component={RouterLink} to="/notes">
                    Notes
                  </Button>
                  {graphEnabled === true && (
                    <>
                      <Button component={RouterLink} to="/graph">
                        Knowledge
                      </Button>
                      <Button component={RouterLink} to="/graph/review">
                        Review
                      </Button>
                      <AskNavButton />
                    </>
                  )}
                  <Button component={RouterLink} to="/settings">
                    Settings
                  </Button>
                  <Box sx={{ flexGrow: 1 }} />
                  <ThemeModeButton />
                </Toolbar>
              </AppBar>
              <Container maxWidth="lg" sx={{ py: 3 }}>
                {/* The routes wait for the switch, so a knowledge link is not sent to /notes while it loads. */}
                {graphEnabled === undefined ? (
                  loading
                ) : (
                  <Suspense fallback={loading}>
                    <Routes>
                      <Route path="/" element={<Navigate to="/notes" replace />} />
                      {renderKvoxRoutes(desktopNotesRoutes)}
                      {graphEnabled && renderKvoxRoutes(desktopKnowledgeRoutes)}
                      {renderDesktopSettingsRoutes()}
                      <Route path="*" element={<Navigate to="/notes" replace />} />
                    </Routes>
                  </Suspense>
                )}
              </Container>
            </ImportProvider>
          </HashRouter>
        </KvoxWebHostProvider>
      </DesktopKnowledgeProvider>
    </DesktopThemeRoot>
  );
}
