import { useEffect, type ReactElement, type ReactNode } from 'react';

import { createKvoxTheme } from '@marinoscar/kvox-web/brand';
import { useShellTheme } from '@marinoscar/platform-web/shell/headless';
import { ShellRoot } from '@marinoscar/platform-web/shell/ui';

import { parseThemeMode, type KvoxDesktopBridge } from '../../shared/protocol';

// =============================================================================
// The theme (marinoscar/kvox-desktop#17)
// =============================================================================
//
// Nothing of the look is defined in this repository. The two themes are the
// brand package's (`createKvoxTheme` of `@marinoscar/kvox-web/brand`: the KVox
// palette, Inter, sentence-case buttons, bordered dark cards), applied by the
// platform's `ShellRoot`, which also holds the viewer's light / dark / system
// choice (`useShellTheme`) and mounts `CssBaseline`. The Inter @font-face is
// imported by main.tsx.
//
// WHERE THE CHOICE LIVES. `ShellRoot` keeps it in localStorage under
// `THEME_STORAGE_KEY`; the renderer's origin (`kvox://app`) is stable, so it
// survives a restart. The main process needs the choice BEFORE any page exists,
// to paint the window in the right colour (no white flash in dark mode), so the
// page also tells main (`ThemeModeSync`, kept in `<userData>/settings.json`).
// localStorage is the first source; the shell's copy is the fallback when it
// comes back empty (`restoreThemeMode`).
// =============================================================================

/** The `localStorage` key of `ShellRoot` (its own default, spelled out because `restoreThemeMode` writes it too). */
export const THEME_STORAGE_KEY = 'theme_mode';

/** The two themes, built once. */
export const DESKTOP_THEMES = { light: createKvoxTheme('light'), dark: createKvoxTheme('dark') };

/**
 * Before the first render: when localStorage holds no choice (cleared, or a profile that never wrote one)
 * but the shell remembers one, copy it back so `ShellRoot` starts from it. Never throws; `system`, the
 * default, needs no entry.
 */
export async function restoreThemeMode(bridge: Pick<KvoxDesktopBridge, 'themeMode'>): Promise<void> {
  try {
    if (localStorage.getItem(THEME_STORAGE_KEY) !== null) return;
    const saved = parseThemeMode(await bridge.themeMode());
    if (saved !== null && saved !== 'system') localStorage.setItem(THEME_STORAGE_KEY, saved);
  } catch {
    // No storage or no bridge answer: `ShellRoot` starts from `system`.
  }
}

/** Tells the shell the mode in force (renders nothing), so the next launch paints the window in it. */
function ThemeModeSync(): null {
  const { mode } = useShellTheme();
  useEffect(() => {
    const builtin = parseThemeMode(mode);
    if (builtin !== null) void window.kvoxDesktop.setThemeMode(builtin).catch(() => undefined);
  }, [mode]);
  return null;
}

/** `ShellRoot` with the KVox themes: MUI's `ThemeProvider`, `CssBaseline` and the mode store, around `children`. */
export function DesktopThemeRoot({ children }: { children: ReactNode }): ReactElement {
  return (
    <ShellRoot themes={DESKTOP_THEMES} storageKey={THEME_STORAGE_KEY}>
      <ThemeModeSync />
      {children}
    </ShellRoot>
  );
}
