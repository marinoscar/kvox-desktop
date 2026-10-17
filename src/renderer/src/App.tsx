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
import { desktopNotesRoutes, renderKvoxRoutes } from './routes';
import { SettingsPage } from './settings/SettingsPage';

// The shell: one bar, the notes destination, the notes routes and the
// settings page (the cards of `settings/registry.tsx`; the full settings hub
// and theming are D3, marinoscar/kvox#584).

const theme = createTheme({ colorSchemes: { light: true, dark: true } });

export function App({ connection }: { connection: DesktopConnection }) {
  const host = useMemo(() => createDesktopHost(connection), [connection]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <KvoxWebHostProvider host={host}>
        <HashRouter>
          <AppBar position="sticky" color="default" elevation={1}>
            <Toolbar sx={{ gap: 2 }}>
              <Typography variant="h6" component="span">
                KVox
              </Typography>
              <Button component={RouterLink} to="/notes">
                Notes
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
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/notes" replace />} />
              </Routes>
            </Suspense>
          </Container>
        </HashRouter>
      </KvoxWebHostProvider>
    </ThemeProvider>
  );
}
