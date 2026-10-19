import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { kvoxTokens } from '@marinoscar/kvox-web/brand';
import { useShellTheme, type ShellThemeContextValue } from '@marinoscar/platform-web/shell/headless';
import { useTheme, type Theme } from '@mui/material/styles';

import { readShellSettings, writeShellSettings } from '../../src/main/shell-settings';
import { windowBackground } from '../../src/main/window-background';
import { parseThemeMode } from '../../src/shared/protocol';
import { DesktopThemeRoot, THEME_STORAGE_KEY, restoreThemeMode } from '../../src/renderer/src/theme';

// =============================================================================
// The KVox theme on Desktop (marinoscar/kvox-desktop#17)
// =============================================================================
//
// The look comes from `@marinoscar/kvox-web/brand` through the platform's ShellRoot, and
// nothing of it is defined here. This file pins that: the source has no `createTheme(` and
// no colour literal, the palette per mode is the package's tokens (and the values the issue
// lists), buttons are sentence case, the saved choice is restored and the window is painted
// in the saved mode's page ground. The rendering is server-side (react-dom/server): the
// themes need no DOM, and the pixels are checked in the packaged app (tests/e2e/smoke.spec.ts).
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');

/** Every .ts/.tsx/.html file under `dir`, except declaration files. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|html)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** A `localStorage` in memory. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

/** What a component under `DesktopThemeRoot` sees, with `saved` as the stored choice. */
function render(saved?: string): { theme: Theme; shell: ShellThemeContextValue } {
  vi.stubGlobal('localStorage', memoryStorage(saved === undefined ? {} : { [THEME_STORAGE_KEY]: saved }));
  let seen: { theme: Theme; shell: ShellThemeContextValue } | undefined;
  function Probe() {
    seen = { theme: useTheme(), shell: useShellTheme() };
    return null;
  }
  renderToString(createElement(DesktopThemeRoot, null, createElement(Probe)));
  if (!seen) throw new Error('the probe did not render');
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('nothing of the look is defined in this repository', () => {
  const renderer = sourceFiles(join(ROOT, 'src', 'renderer'));

  it('has no createTheme( call in src/renderer', () => {
    const offenders = renderer.filter((file) => /\bcreateTheme\(/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('writes no colour literal in the renderer or the main process', () => {
    const files = [...renderer, ...sourceFiles(join(ROOT, 'src', 'main'))];
    const offenders = files.filter((file) => /#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(/.test(readFileSync(file, 'utf8').replace(/https?:\/\/\S*/g, '')));
    expect(offenders.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
  });

  it('takes the theme from the brand package, applied by ShellRoot', () => {
    const theme = readFileSync(join(ROOT, 'src/renderer/src/theme.tsx'), 'utf8');
    expect(theme).toContain("from '@marinoscar/kvox-web/brand'");
    expect(theme).toContain("createKvoxTheme('light')");
    expect(theme).toContain("createKvoxTheme('dark')");
    expect(theme).toContain("from '@marinoscar/platform-web/shell/ui'");
    expect(readFileSync(join(ROOT, 'src/renderer/src/App.tsx'), 'utf8')).toContain('<DesktopThemeRoot>');
  });

  it('loads Inter from the package, with the CSP unchanged', () => {
    expect(readFileSync(join(ROOT, 'src/renderer/src/main.tsx'), 'utf8')).toContain("import '@marinoscar/kvox-web/brand/fonts/inter.css'");
    const html = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8');
    expect(html).toContain("font-src 'self' data:");
    expect(html).toContain("default-src 'self'");
    expect(html).not.toContain('https://');
  });

  it('switches the theme from the application menu through ShellRoot, not MUI colour schemes', () => {
    const menu = readFileSync(join(ROOT, 'src/renderer/src/MenuCommands.tsx'), 'utf8');
    expect(menu).toContain('useShellTheme');
    expect(menu).toContain('toggleMode');
    expect(menu).not.toContain('useColorScheme');
  });
});

describe('the palette per mode', () => {
  it('dark: #0f1117 ground, #171a23 cards, #a5b4fc primary with dark text', () => {
    const { theme, shell } = render('dark');
    expect(shell.mode).toBe('dark');
    expect(theme.palette.mode).toBe('dark');
    expect(theme.palette.background.default).toBe('#0f1117');
    expect(theme.palette.background.paper).toBe('#171a23');
    expect(theme.palette.primary.main).toBe('#a5b4fc');
    expect(theme.palette.primary.contrastText).toBe(kvoxTokens.dark.primary.contrastText);
    expect(theme.palette.secondary.main).toBe(kvoxTokens.dark.secondary.main);
    expect(theme.palette.success.main).toBe(kvoxTokens.dark.success);
  });

  it('light: #f6f7fb ground, #4f46e5 primary', () => {
    const { theme, shell } = render('light');
    expect(shell.mode).toBe('light');
    expect(theme.palette.mode).toBe('light');
    expect(theme.palette.background.default).toBe('#f6f7fb');
    expect(theme.palette.primary.main).toBe('#4f46e5');
    expect(theme.palette.success.main).toBe(kvoxTokens.light.success);
  });

  it('is the brand tokens in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { theme } = render(mode);
      expect(theme.palette.background.default).toBe(kvoxTokens[mode].background.default);
      expect(theme.palette.background.paper).toBe(kvoxTokens[mode].background.paper);
      expect(theme.palette.primary.main).toBe(kvoxTokens[mode].primary.main);
      expect(theme.palette.divider).toBe(kvoxTokens[mode].divider);
    }
  });

  it('starts on system when nothing is saved, and on system for a value it does not know', () => {
    expect(render().shell.mode).toBe('system');
    expect(render('sepia').shell.mode).toBe('system');
  });

  it('sets Inter first and sentence-case buttons', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { theme } = render(mode);
      expect(theme.typography.fontFamily).toMatch(/^"?Inter"?\b/);
      const button = theme.components?.MuiButton?.styleOverrides?.root as Record<string, unknown>;
      expect(button.textTransform).toBe('none');
    }
  });

  it('draws a dark card with a 1px divider border and no shadow', () => {
    const { theme } = render('dark');
    const card = theme.components?.MuiCard?.styleOverrides?.root as (args: { theme: Theme }) => Record<string, string>;
    expect(card({ theme })).toEqual({ boxShadow: 'none', border: `1px solid ${theme.palette.divider}` });
  });
});

describe('the saved choice', () => {
  it('is restored from the shell when localStorage has none (the fallback)', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    await restoreThemeMode({ themeMode: async () => 'dark' });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('never overrides what localStorage holds (it is the first source)', async () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: 'light' });
    vi.stubGlobal('localStorage', storage);
    const themeMode = vi.fn(async () => 'dark' as const);
    await restoreThemeMode({ themeMode });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(themeMode).not.toHaveBeenCalled();
  });

  it('writes nothing for system, and survives a failing bridge or storage', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    await restoreThemeMode({ themeMode: async () => 'system' });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await expect(restoreThemeMode({ themeMode: async () => Promise.reject(new Error('no bridge')) })).resolves.toBeUndefined();
    vi.stubGlobal('localStorage', undefined);
    await expect(restoreThemeMode({ themeMode: async () => 'dark' })).resolves.toBeUndefined();
  });

  it('accepts only the three modes over IPC', () => {
    expect(['light', 'dark', 'system'].map(parseThemeMode)).toEqual(['light', 'dark', 'system']);
    expect([undefined, null, 'Dark', 'sepia', 1, {}].map(parseThemeMode)).toEqual([null, null, null, null, null, null]);
  });
});

describe('the shell settings keep the choice', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('defaults to system, persists a mode with the other settings, and reads a damaged value as system', () => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-theme-'));
    const path = join(dir, 'settings.json');
    expect(readShellSettings(path).themeMode).toBe('system');
    const settings = readShellSettings(path);
    settings.themeMode = 'dark';
    settings.updates.checkForUpdates = true;
    writeShellSettings(path, settings);
    expect(readShellSettings(path)).toMatchObject({ themeMode: 'dark', updates: { checkForUpdates: true } });
    writeShellSettings(path, { ...settings, themeMode: 'neon' as never });
    expect(readShellSettings(path).themeMode).toBe('system');
  });
});

describe('the window background', () => {
  it('is the brand page ground of the saved mode, with no hex value of its own', () => {
    expect(windowBackground('dark', false)).toBe(kvoxTokens.dark.background.default);
    expect(windowBackground('light', true)).toBe(kvoxTokens.light.background.default);
    expect(windowBackground('dark', false)).toBe('#0f1117');
    expect(windowBackground('light', true)).toBe('#f6f7fb');
  });

  it('follows the OS only for system', () => {
    expect(windowBackground('system', true)).toBe(kvoxTokens.dark.background.default);
    expect(windowBackground('system', false)).toBe(kvoxTokens.light.background.default);
  });

  it('is set on the BrowserWindow from the saved mode', () => {
    const main = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
    expect(main).toMatch(/backgroundColor: windowBackground\(themeMode, nativeTheme\.shouldUseDarkColors\)/);
    expect(main).toContain('readShellSettings(settingsPath()).themeMode');
  });
});
