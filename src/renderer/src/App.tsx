import { Suspense, useMemo } from 'react';
import { HashRouter, Link as RouterLink, Navigate, Route, Routes } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import CssBaseline from '@mui/material/CssBaseline';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import { KvoxWebHostProvider } from '@marinoscar/kvox-web/core/headless';

import type { DesktopConnection } from '../../shared/protocol';
import { createDesktopHost } from './host';
import { ImportProvider } from './import/ImportProvider';
import { desktopKnowledgeRoutes, desktopNotesRoutes, renderKvoxRoutes } from './routes';
import { SettingsPage } from './settings/SettingsPage';

// The shell: one bar, the notes destination, the notes routes, the import
// (the "Import…" action and a window-wide drop target, marinoscar/kvox#585),
// the knowledge destinations (Knowledge: the graph index, entity pages, the
// explorer and the overview; Review: the proposals waiting; Ask; marinoscar/kvox#586)
// and the settings page (the cards of `settings/registry.tsx`).

const theme = createTheme({ colorSchemes: { light: true, dark: true } });

export function App({ connection }: { connection: DesktopConnection }) {
  const host = useMemo(() => createDesktopHost(connection), [connection]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <KvoxWebHostProvider host={host}>
        <HashRouter>
          <ImportProvider>
            <AppBar position="sticky" color="default" elevation={1}>
              <Toolbar sx={{ gap: 2 }}>
                <Typography variant="h6" component="span">
                  KVox
                </Typography>
                <Button component={RouterLink} to="/notes">
                  Notes
                </Button>
                <Button component={RouterLink} to="/graph">
                  Knowledge
                </Button>
                <Button component={RouterLink} to="/graph/review">
                  Review
                </Button>
                <Button component={RouterLink} to="/ask">
                  Ask
                </Button>
                <Button component={RouterLink} to="/settings/note-templates">
                  Templates
                </Button>
                <Button component={RouterLink} to="/settings">
                  Settings
                </Button>
              </Toolbar>
            </AppBar>
            <Container maxWidth="lg" sx={{ py: 3 }}>
              <Suspense
                fallback={
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                    <CircularProgress aria-label="Loading" />
                  </Box>
                }
              >
                <Routes>
                  <Route path="/" element={<Navigate to="/notes" replace />} />
                  {renderKvoxRoutes(desktopNotesRoutes)}
                  {renderKvoxRoutes(desktopKnowledgeRoutes)}
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/notes" replace />} />
                </Routes>
              </Suspense>
            </Container>
          </ImportProvider>
        </HashRouter>
      </KvoxWebHostProvider>
    </ThemeProvider>
  );
}
