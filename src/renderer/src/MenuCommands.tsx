import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useColorScheme } from '@mui/material/styles';

import { parseMenuPath } from '../../shared/protocol';
import { useImport } from './import/ImportProvider';

// The commands of the application menu (src/main/menu.ts, marinoscar/kvox-desktop#20).
// Main sends them over IPC; this component, inside the router, the import
// provider and the theme, validates and runs them. It renders nothing.
//
//   navigate      an in-app path, accepted only as `parseMenuPath` allows
//   toggle theme  light <-> dark (the resolved scheme when the mode is "system")
//   import        the same dialog as the "Import…" action
export function MenuCommands(): null {
  const navigate = useNavigate();
  const { chooseAndImport } = useImport();
  const { mode, systemMode, setMode } = useColorScheme();
  const current = mode === 'system' ? systemMode : mode;

  useEffect(() => {
    const bridge = window.kvoxDesktop;
    return bridge.onMenuNavigate((payload) => {
      const path = parseMenuPath(payload);
      if (path) navigate(path);
    });
  }, [navigate]);

  useEffect(() => window.kvoxDesktop.onMenuImport(() => chooseAndImport()), [chooseAndImport]);

  useEffect(
    () => window.kvoxDesktop.onMenuToggleTheme(() => setMode(current === 'dark' ? 'light' : 'dark')),
    [current, setMode],
  );

  return null;
}
