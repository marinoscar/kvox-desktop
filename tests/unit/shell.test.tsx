// @vitest-environment jsdom
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readShellSettings, writeShellSettings } from '../../src/main/shell-settings';
import type { DesktopConnection, KvoxDesktopBridge } from '../../src/shared/protocol';
import { App } from '../../src/renderer/src/App';
import {
  DESKTOP_NAVIGATION,
  createDesktopPlatformHost,
  createDesktopShellPreferencesPort,
  desktopUserMenuItems,
} from '../../src/renderer/src/shell';

// =============================================================================
// The shell (marinoscar/kvox-desktop#18)
// =============================================================================
//
// The real `App` is rendered in jsdom against a stubbed bridge (`window.kvoxDesktop`) and a stubbed `fetch`
// that answers the local server's connected-knowledge route and records everything else. It proves the
// bindings, not the shell (that is the kvox-web package's test): the destinations and their order, the
// `graph` gate following the switch live, the user menu's rows, the rail preference going through the port
// (and so through the bridge), and that nothing reaches a platform API route.
//
// jsdom has no layout: `matchMedia` is a stub driven by the window width below, which is how the platform's
// own gates (`up('sm')`, `up('lg')`) decide between the rail and the bottom bar. This file reads no
// breakpoint itself.
// =============================================================================

const CONNECTION: DesktopConnection = {
  baseUrl: 'http://127.0.0.1:4999',
  token: 'test-token',
  userId: 'local-user',
  permissions: ['notes:read', 'notes:write', 'note_templates:read', 'note_templates:write', 'graph:read', 'graph:write', 'ask:read', 'ask:write'],
  displayName: 'Ada',
};

let width = 1280;

/** A `matchMedia` that evaluates min-width / max-width queries against `width` (what MUI's breakpoints emit). */
function installMatchMedia(): void {
  window.matchMedia = ((query: string) => {
    const evaluate = (): boolean => {
      const min = /\(min-width:\s*([\d.]+)px\)/.exec(query);
      const max = /\(max-width:\s*([\d.]+)px\)/.exec(query);
      if (min) return width >= Number(min[1]);
      if (max) return width <= Number(max[1]);
      return false;
    };
    return {
      matches: evaluate(),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

interface Harness {
  bridge: KvoxDesktopBridge;
  requests: string[];
  setRailCollapsed: ReturnType<typeof vi.fn>;
  openDataFolder: ReturnType<typeof vi.fn>;
  showAbout: ReturnType<typeof vi.fn>;
}

function install({ graphEnabled = true, railCollapsed = false }: { graphEnabled?: boolean; railCollapsed?: boolean } = {}): Harness {
  let graph = graphEnabled;
  const requests: string[] = [];
  const setRailCollapsed = vi.fn(async (_patch: { railCollapsed?: boolean }) => undefined);
  const openDataFolder = vi.fn(async () => undefined);
  const showAbout = vi.fn(async () => undefined);
  const bridge: KvoxDesktopBridge = {
    connection: async () => CONNECTION,
    dataFolder: async () => '/data',
    chooseBackupTarget: async () => null,
    chooseBackupSource: async () => null,
    secretStorage: async () => ({ available: true, backend: null, plaintextAccepted: false }),
    acceptPlaintextSecrets: async () => ({ available: true, backend: null, plaintextAccepted: false }),
    updates: async () => ({ enabled: false, state: 'off', currentVersion: '0.0.0' }),
    setUpdatesEnabled: async () => ({ enabled: false, state: 'off', currentVersion: '0.0.0' }),
    installUpdate: async () => undefined,
    importFromDialog: async () => null,
    importDropped: async () => [],
    themeMode: async () => 'system',
    setThemeMode: async () => undefined,
    shellPreferences: async () => ({ railCollapsed }),
    setShellPreferences: setRailCollapsed,
    openDataFolder,
    showAbout,
    onMenuNavigate: () => () => undefined,
    onMenuToggleTheme: () => () => undefined,
    onMenuImport: () => () => undefined,
  };
  window.kvoxDesktop = bridge;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/desktop/knowledge') {
        if (init?.method === 'PATCH') graph = (JSON.parse(String(init.body)) as { graphEnabled: boolean }).graphEnabled;
        return new Response(JSON.stringify({ graphEnabled: graph }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { bridge, requests, setRailCollapsed, openDataFolder, showAbout };
}

const mainNavigation = () => screen.getByRole('navigation', { name: 'Main navigation' });
const railNames = () => within(mainNavigation()).getAllByRole('link').map((link) => link.getAttribute('aria-label'));

async function renderApp(hash = '#/settings'): Promise<void> {
  window.location.hash = hash;
  render(<App connection={CONNECTION} />);
  // The routes (so the hub) appear once the knowledge switch has been read.
  await waitFor(() => expect(document.querySelector('main')?.textContent).not.toBe(''));
}

/** The user menu's trigger (the avatar button carries no name of its own). */
const userMenuButton = () => document.querySelector<HTMLButtonElement>('header button[aria-haspopup="true"]')!;

beforeEach(() => {
  width = 1280;
  localStorage.clear();
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the destinations', () => {
  it('lists Notes, Knowledge, Review, Ask and Settings pinned at the foot, with no Templates row', async () => {
    install();
    await renderApp();
    await waitFor(() => expect(railNames()).toEqual(['Notes', 'Knowledge', 'Review', 'Ask', 'Settings']));
    // Templates is a Settings card (the hub lists it), not a destination.
    expect(within(mainNavigation()).queryByRole('link', { name: 'Templates' })).toBeNull();
    expect(DESKTOP_NAVIGATION.destinations.map((destination) => destination.key)).toEqual(['notes', 'knowledge', 'review', 'ask', 'settings']);
    expect(DESKTOP_NAVIGATION.destinations.find((destination) => destination.key === 'settings')?.pinned).toBe(true);
  });

  it('highlights the active route', async () => {
    install();
    await renderApp('#/settings');
    await waitFor(() => expect(within(mainNavigation()).getByRole('link', { name: 'Settings' })).toHaveProperty('ariaCurrent', 'page'));
    expect(within(mainNavigation()).getByRole('link', { name: 'Notes' }).getAttribute('aria-current')).toBeNull();
  });

  it('hides Knowledge, Review and Ask while connected knowledge is off, and shows them again without a restart', async () => {
    install({ graphEnabled: false });
    await renderApp('#/settings/knowledge');
    await waitFor(() => expect(railNames()).toEqual(['Notes', 'Settings']));

    const toggle = await screen.findByLabelText('Connected knowledge');
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(railNames()).toEqual(['Notes', 'Knowledge', 'Review', 'Ask', 'Settings']));

    fireEvent.click(await screen.findByLabelText('Connected knowledge'));
    await waitFor(() => expect(railNames()).toEqual(['Notes', 'Settings']));
  });

  it('shows the non-pinned destinations in the bottom bar of a small window, and not Settings', async () => {
    width = 500;
    install();
    await renderApp();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    const labelled = () => Array.from(document.querySelectorAll('button[aria-label], a[aria-label]'), (el) => el.getAttribute('aria-label'));
    await waitFor(() => expect(labelled()).toEqual(expect.arrayContaining(['Notes', 'Knowledge'])));
    // Settings is a mode, never a peer on the phone bar (it is reached from the hub and the user menu).
    expect(labelled()).not.toContain('Settings');
  });

  it('titles a settings page in the app bar from the registry (the card title)', async () => {
    width = 500;
    install();
    await renderApp('#/settings/data');
    await waitFor(() => expect(document.querySelector('header')!.textContent).toContain('Data and privacy'));
  });
});

describe('the app bar and the user menu', () => {
  it('has the KVox mark and name, the theme toggle, and the two host rows without sign-out or an organization switcher', async () => {
    const harness = install();
    await renderApp();
    expect(screen.getByRole('button', { name: 'toggle theme' })).toBeTruthy();
    expect(screen.getAllByText('KVox').length).toBeGreaterThan(0);

    // The avatar button carries the local user's name (the OS user name from the connection).
    fireEvent.click(userMenuButton());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Ada')).toBeTruthy();
    const labels = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Open data folder', 'About KVox']));
    expect(labels.filter((label) => /sign out|log ?out|organi[sz]ation/i.test(label ?? ''))).toEqual([]);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open data folder' }));
    expect(harness.openDataFolder).toHaveBeenCalledTimes(1);
    fireEvent.click(userMenuButton());
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'About KVox' }));
    expect(harness.showAbout).toHaveBeenCalledTimes(1);
  });

  it('names the local user "You" when the OS gives no name', async () => {
    install();
    window.location.hash = '#/settings';
    render(<App connection={{ ...CONNECTION, displayName: undefined }} />);
    await waitFor(() => expect(document.querySelector('main')?.textContent).not.toBe(''));
    fireEvent.click(userMenuButton());
    expect(within(await screen.findByRole('menu')).getByText('You')).toBeTruthy();
  });

  it('builds the two menu rows over the bridge', () => {
    const bridge = { openDataFolder: vi.fn(async () => undefined), showAbout: vi.fn(async () => undefined) };
    const items = desktopUserMenuItems(bridge);
    expect(items.map((item) => [item.key, item.label])).toEqual([
      ['data-folder', 'Open data folder'],
      ['about', 'About KVox'],
    ]);
    items.forEach((item) => item.onClick());
    expect(bridge.openDataFolder).toHaveBeenCalled();
    expect(bridge.showAbout).toHaveBeenCalled();
  });
});

describe('the rail preference', () => {
  it('writes the collapse through the port, so through the bridge to the shell settings', async () => {
    const harness = install();
    await renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse navigation' }));
    await waitFor(() => expect(harness.setRailCollapsed).toHaveBeenCalledWith({ railCollapsed: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand navigation' }));
    await waitFor(() => expect(harness.setRailCollapsed).toHaveBeenLastCalledWith({ railCollapsed: false }));
    // Nothing went to the browser's own storage: the bridge is the store.
    expect(localStorage.length).toBeLessThanOrEqual(1); // ShellRoot's theme key at most
  });

  it('starts collapsed when the shell settings say so (the state persists across restarts)', async () => {
    install({ railCollapsed: true });
    await renderApp();
    expect(await screen.findByRole('button', { name: 'Expand navigation' })).toBeTruthy();
  });

  it('reads and writes through the bridge when it has the calls, else through localStorage', async () => {
    const bridge = { shellPreferences: vi.fn(async () => ({ railCollapsed: true })), setShellPreferences: vi.fn(async () => undefined) };
    const port = createDesktopShellPreferencesPort(bridge);
    expect(await port.read()).toEqual({ railCollapsed: true });
    await port.write({ railCollapsed: false });
    expect(bridge.setShellPreferences).toHaveBeenCalledWith({ railCollapsed: false });

    const fallback = createDesktopShellPreferencesPort(undefined);
    expect(await fallback.read()).toEqual({});
    await fallback.write({ railCollapsed: true });
    expect(await createDesktopShellPreferencesPort({}).read()).toEqual({ railCollapsed: true });
  });
});

describe('the rail preference in the shell settings file', () => {
  it('defaults to expanded, persists with the other settings, and reads anything but true as expanded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvox-rail-'));
    try {
      const path = join(dir, 'settings.json');
      expect(readShellSettings(path).shell).toEqual({ railCollapsed: false });
      const settings = readShellSettings(path);
      settings.shell.railCollapsed = true;
      settings.themeMode = 'dark';
      writeShellSettings(path, settings);
      expect(readShellSettings(path)).toMatchObject({ shell: { railCollapsed: true }, themeMode: 'dark' });
      writeFileSync(path, JSON.stringify({ shell: { railCollapsed: 'yes' } }));
      expect(readShellSettings(path).shell.railCollapsed).toBe(false);
      writeFileSync(path, '{ not json');
      expect(readShellSettings(path).shell.railCollapsed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('no platform API', () => {
  it('makes no request to a platform route (user-settings, auth, users) while the shell and the hub render', async () => {
    const harness = install();
    await renderApp();
    await waitFor(() => expect(railNames()).toContain('Knowledge'));
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse navigation' }));
    expect(harness.requests.length).toBeGreaterThan(0);
    expect(harness.requests.filter((request) => !request.endsWith('/api/desktop/knowledge'))).toEqual([]);
    expect(harness.requests.filter((request) => /user-settings|\/auth|\/users|\/org/.test(request))).toEqual([]);
  });

  it('refuses every platform API call of the host (a rejecting stub), and answers the viewer from the connection', async () => {
    const host = createDesktopPlatformHost(CONNECTION, true);
    await expect(host.api.get('/user-settings')).rejects.toThrow(/no platform API/);
    await expect(host.api.patch('/user-settings', {})).rejects.toThrow(/no platform API/);
    expect(host.viewer.userId).toBe('local-user');
    expect(host.viewer.hasPermission('notes:read')).toBe(true);
    expect(host.viewer.hasPermission('users:read')).toBe(false);
    expect(host.viewer.isFeatureEnabled('graph')).toBe(true);
    expect(createDesktopPlatformHost(CONNECTION, undefined).viewer.isFeatureEnabled('graph')).toBe(false);
  });
});

describe('no copies, no breakpoints', () => {
  const dir = join(__dirname, '../../src/renderer/src');
  const sources: Array<{ file: string; text: string }> = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) sources.push({ file: path.slice(dir.length + 1), text: readFileSync(path, 'utf8') });
    }
  };
  walk(dir);

  it('defines no route renderer, links or app bar of its own (only package imports and calls)', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/function\s+renderKvoxRoutes|const\s+renderKvoxRoutes|const\s+kvoxLinks|kvoxLinks\s*=|AppBar/);
    }
  });

  it('reads no breakpoint (the five gates are the platform\'s)', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/useMediaQuery|breakpoints\.(up|down|between|only)|matchMedia/);
    }
  });
});
