import { useState, type ReactElement } from 'react';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightnessOutlined';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';

import { useShellTheme } from '@marinoscar/platform-web/shell/headless';

import type { ThemeMode } from '../../shared/protocol';

// TEMPORARY (marinoscar/kvox-desktop#17): the light / dark / system choice in the current app bar. The
// shared shell (#18, `KvoxAppShell`) carries the toggle and this file goes with the bar. The choice itself
// is `ShellRoot`'s (`useShellTheme`); this only renders and sets it.
const CHOICES: ReadonlyArray<{ mode: ThemeMode; label: string; Icon: typeof LightModeIcon }> = [
  { mode: 'light', label: 'Light', Icon: LightModeIcon },
  { mode: 'dark', label: 'Dark', Icon: DarkModeIcon },
  { mode: 'system', label: 'System', Icon: SettingsBrightnessIcon },
];

export function ThemeModeButton(): ReactElement {
  const { mode, setMode } = useShellTheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = CHOICES.find((choice) => choice.mode === mode) ?? CHOICES[2];
  return (
    <>
      <Tooltip title={`Theme: ${current.label}`}>
        <IconButton
          color="inherit"
          aria-label={`Theme: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <current.Icon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {CHOICES.map(({ mode: choice, label, Icon }) => (
          <MenuItem
            key={choice}
            selected={choice === mode}
            onClick={() => {
              setMode(choice);
              setAnchor(null);
            }}
          >
            <ListItemIcon>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
