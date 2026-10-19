import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { aboutIconPath, windowIconPath } from '../../src/main/app-icon';
import { aboutDetails, buildMenuTemplate, packageVersions } from '../../src/main/menu';
import { parseMenuPath } from '../../src/shared/protocol';

// menu.ts imports Electron's runtime objects; the template builder needs none of them (vi.mock is hoisted).
vi.mock('electron', () => ({ Menu: {}, app: {}, dialog: {}, shell: {} }));

// =============================================================================
// The application menu (marinoscar/kvox-desktop#20)
// =============================================================================
// The template's shape, the dev-only items, the absence of any remote link
// (ADR-0004), the commands each item sends, and the renderer-side validation of
// a `menu:navigate` path.
// =============================================================================

const ROOT = resolve(__dirname, '..', '..');

function actionsSpy() {
  return {
    navigate: vi.fn(),
    importFiles: vi.fn(),
    toggleTheme: vi.fn(),
    showAbout: vi.fn(),
    openDataFolder: vi.fn(),
    openLicences: vi.fn(),
  };
}

const template = (platform: NodeJS.Platform, isPackaged: boolean, actions = actionsSpy()) =>
  buildMenuTemplate({ platform, isPackaged, actions });

/** Every item of the template, submenus flattened. */
function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])]);
}

const menuOf = (items: MenuItemConstructorOptions[], label: string) => items.find((item) => item.label === label);
const labelsOf = (item: MenuItemConstructorOptions | undefined) =>
  (Array.isArray(item?.submenu) ? item.submenu : []).map((child) => child.label ?? child.role ?? child.type);
const roles = (items: MenuItemConstructorOptions[]) => walk(items).flatMap((item) => (item.role ? [String(item.role)] : []));
const find = (items: MenuItemConstructorOptions[], label: string) => walk(items).find((item) => item.label === label);

describe('the menu template', () => {
  it('has File, Edit, View, Window and Help on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(template(platform, true).map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    }
  });

  it('puts the KVox menu first on macOS, named KVox, with About, Settings and Quit', () => {
    const items = template('darwin', true);
    expect(items.map((item) => item.label ?? item.role)).toEqual(['KVox', 'File', 'Edit', 'View', 'windowMenu', 'Help']);
    expect(labelsOf(menuOf(items, 'KVox'))).toEqual(
      expect.arrayContaining(['About KVox', 'Settings…', 'Hide KVox', 'Quit KVox']),
    );
    // Settings and Quit live in the KVox menu there, not in File; About not in Help.
    expect(labelsOf(menuOf(items, 'File'))).toEqual(['New note', 'Import…']);
    expect(labelsOf(menuOf(items, 'Help'))).toEqual(['Open data folder', 'View licences']);
  });

  it('File: New note, Import…, Settings, Quit with their accelerators', () => {
    const file = menuOf(template('win32', true), 'File');
    expect(labelsOf(file)).toEqual(['New note', 'Import…', 'separator', 'Settings', 'separator', 'quit']);
    const items = file?.submenu as MenuItemConstructorOptions[];
    expect(items.find((i) => i.label === 'New note')?.accelerator).toBe('CmdOrCtrl+N');
    expect(items.find((i) => i.label === 'Import…')?.accelerator).toBe('CmdOrCtrl+O');
    expect(items.find((i) => i.label === 'Settings')?.accelerator).toBe('CmdOrCtrl+,');
  });

  it('Edit has the standard roles', () => {
    const edit = menuOf(template('linux', true), 'Edit')?.submenu as MenuItemConstructorOptions[];
    expect(edit.flatMap((item) => (item.role ? [String(item.role)] : []))).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  });

  it('View: theme toggle, zoom and full screen; Window: minimize and close; Help: About, data folder, licences', () => {
    const items = template('win32', true);
    expect(labelsOf(menuOf(items, 'View'))).toEqual([
      'Toggle light/dark',
      'separator',
      'Actual size',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen',
    ]);
    expect(labelsOf(menuOf(items, 'Window'))).toEqual(['minimize', 'close']);
    expect(labelsOf(menuOf(items, 'Help'))).toEqual(['About KVox', 'separator', 'Open data folder', 'View licences']);
  });

  it('sends each command to its action', () => {
    const actions = actionsSpy();
    const items = template('linux', true, actions);
    const click = (label: string) => (find(items, label)?.click as () => void)();
    click('New note');
    expect(actions.navigate).toHaveBeenLastCalledWith('/notes/new');
    click('Settings');
    expect(actions.navigate).toHaveBeenLastCalledWith('/settings');
    click('Import…');
    expect(actions.importFiles).toHaveBeenCalledOnce();
    click('Toggle light/dark');
    expect(actions.toggleTheme).toHaveBeenCalledOnce();
    click('About KVox');
    expect(actions.showAbout).toHaveBeenCalledOnce();
    click('Open data folder');
    expect(actions.openDataFolder).toHaveBeenCalledOnce();
    click('View licences');
    expect(actions.openLicences).toHaveBeenCalledOnce();
  });
});

describe('developer items', () => {
  const developerRoles = ['reload', 'forceReload', 'toggleDevTools'];

  it('are absent from a packaged app on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const present = roles(template(platform, true));
      for (const role of developerRoles) expect(present, `${platform}: ${role}`).not.toContain(role);
    }
  });

  it('exist only while the app is not packaged', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(roles(template(platform, false))).toEqual(expect.arrayContaining(developerRoles));
    }
  });
});

describe('no remote links (ADR-0004)', () => {
  const REMOTE = /https?:\/\/|\/\/[a-z0-9-]+\.[a-z]{2,}/i;

  it('has no URL in any label, sublabel, tooltip or click handler', () => {
    for (const isPackaged of [true, false]) {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        for (const item of walk(template(platform, isPackaged))) {
          const text = [item.label, item.sublabel, item.toolTip, item.click?.toString()].filter(Boolean).join('\n');
          expect(text, `${platform} ${item.label ?? item.role}`).not.toMatch(REMOTE);
        }
      }
    }
  });

  it('never calls shell.openExternal and names no URL in menu.ts', () => {
    const source = readFileSync(join(ROOT, 'src', 'main', 'menu.ts'), 'utf8');
    expect(source).not.toContain('openExternal');
    expect(source.replace(/\/\/.*$/gm, '')).not.toMatch(/https?:\/\//);
  });
});

describe('About', () => {
  it('lists the Electron, Chromium and Node versions and the exact @marinoscar package pins', () => {
    const packages = packageVersions({
      dependencies: { '@marinoscar/kvox-api': '0.1.0-next.1', react: '19.0.0', '@marinoscar/kvox-ai': '0.1.0-next.1' },
      devDependencies: { '@marinoscar/kvox-web': '0.1.0-next.1' },
    });
    expect(packages.map(([name]) => name)).toEqual(['@marinoscar/kvox-ai', '@marinoscar/kvox-api', '@marinoscar/kvox-web']);
    const text = aboutDetails({ electron: '44.9.0', chrome: '150.0.1', node: '24.1.0' }, packages);
    expect(text).toContain('Electron 44.9.0');
    expect(text).toContain('Chromium 150.0.1');
    expect(text).toContain('Node.js 24.1.0');
    expect(text).toContain('@marinoscar/kvox-api 0.1.0-next.1');
    expect(text).not.toContain('react');
  });
});

describe('the window icon', () => {
  const base = { resourcesPath: '/opt/KVox/resources', appPath: '/repo' };

  it('is read from the resources folder when packaged and from build/ in development', () => {
    expect(windowIconPath({ ...base, platform: 'linux', isPackaged: true })).toBe(join('/opt/KVox/resources', 'icon.png'));
    expect(windowIconPath({ ...base, platform: 'linux', isPackaged: false })).toBe(join('/repo', 'build', 'linux', 'icon.png'));
    expect(windowIconPath({ ...base, platform: 'win32', isPackaged: true })).toBe(join('/opt/KVox/resources', 'icon.ico'));
    expect(windowIconPath({ ...base, platform: 'win32', isPackaged: false })).toBe(join('/repo', 'build', 'icon.ico'));
  });

  it('is not set on macOS, where the bundle carries the .icns', () => {
    expect(windowIconPath({ ...base, platform: 'darwin', isPackaged: true })).toBeUndefined();
  });

  it('gives the About panel the PNG', () => {
    expect(aboutIconPath({ ...base, isPackaged: true })).toBe(join('/opt/KVox/resources', 'icon.png'));
    expect(aboutIconPath({ ...base, isPackaged: false })).toBe(join('/repo', 'build', 'linux', 'icon.png'));
  });
});

describe('parseMenuPath (the renderer validates what main sends)', () => {
  it('accepts in-app paths', () => {
    for (const path of ['/notes/new', '/settings', '/notes/abc-123', '/notes/new?transcriptId=a%20b&x=1']) {
      expect(parseMenuPath(path), path).toBe(path);
    }
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      '',
      'notes/new',
      '//evil.example/x',
      'https://evil.example',
      'javascript:alert(1)',
      '/\\evil',
      '/notes/../../etc',
      '/notes/<script>',
      '/a b',
      `/${'a'.repeat(250)}`,
    ];
    for (const value of bad) expect(parseMenuPath(value), String(value)).toBeNull();
  });
});
