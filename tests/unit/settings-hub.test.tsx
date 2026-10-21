import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { settingsPageTitle, visibleSettingsSections } from '@marinoscar/platform-web/settings/ui';

import { desktopSettingsRoutes } from '../../src/renderer/src/settings/routes';
import {
  DESKTOP_SETTINGS_PATH,
  DESKTOP_SETTINGS_SECTIONS,
  DESKTOP_SETTINGS_TITLE,
} from '../../src/renderer/src/settings/sections';

// =============================================================================
// Settings through the platform SettingsHub (marinoscar/kvox-desktop#19)
// =============================================================================
//
// REGISTRY PARITY, as in the web edition's registry tests: every settings page
// is a card of DESKTOP_SETTINGS_SECTIONS and every card has a page, so the hub,
// the app-bar title and (after #18) the rail cannot disagree. Plus the issue's
// grep criteria: no hand-made settings stack and no breakpoint read in the
// settings code (the hub's own `isCompactWindow` is the only gate).
// =============================================================================

const cards = DESKTOP_SETTINGS_SECTIONS.flatMap((section) => section.cards);
const routePaths = desktopSettingsRoutes.map((route) => route.path);

describe('the Desktop settings registry', () => {
  it('lists the six cards in the issue order, grouped', () => {
    expect(cards.map((card) => card.title)).toEqual([
      'AI provider',
      'Connected knowledge',
      'Note Templates',
      'Semantic search on this device',
      'Data and privacy',
      'Updates',
    ]);
    expect(cards.map((card) => card.path)).toEqual([
      '/settings/ai',
      '/settings/knowledge',
      '/settings/note-templates',
      '/settings/search',
      '/settings/data',
      '/settings/updates',
    ]);
    expect(DESKTOP_SETTINGS_SECTIONS.every((section) => section.label !== '' && section.cards.length > 0)).toBe(true);
  });

  it('has a route for every card and a card for every route (parity)', () => {
    expect([...routePaths].sort()).toEqual(cards.map((card) => card.path).sort());
    expect(new Set(routePaths).size).toBe(routePaths.length);
    expect(new Set(cards.map((card) => card.title)).size).toBe(cards.length);
  });

  it('keeps every route under the hub, and the hub itself is not a card', () => {
    for (const path of routePaths) expect(path.startsWith(`${DESKTOP_SETTINGS_PATH}/`)).toBe(true);
    expect(cards.some((card) => card.path === DESKTOP_SETTINGS_PATH)).toBe(false);
  });

  it('describes every card (description, icon) and gates none: one local user, every card shown', () => {
    for (const card of cards) {
      expect(card.description, card.title).not.toBe('');
      expect(card.Icon, card.title).toBeDefined();
      expect(card.permission, card.title).toBeUndefined();
      expect(card.feature, card.title).toBeUndefined();
      expect(card.disabled, card.title).toBeFalsy();
    }
    // The hub's own filter (permissions and features) drops nothing, even with no permission check at all.
    expect(visibleSettingsSections(DESKTOP_SETTINGS_SECTIONS, () => false)).toEqual(DESKTOP_SETTINGS_SECTIONS);
  });

  it('titles every page from the registry, as the app bar does, and the hub as Settings', () => {
    for (const card of cards) {
      expect(settingsPageTitle(DESKTOP_SETTINGS_SECTIONS, DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_TITLE, card.path!)).toBe(card.title);
    }
    expect(settingsPageTitle(DESKTOP_SETTINGS_SECTIONS, DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_TITLE, DESKTOP_SETTINGS_PATH)).toBe('Settings');
    expect(settingsPageTitle(DESKTOP_SETTINGS_SECTIONS, DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_TITLE, '/notes')).toBeNull();
  });

  it('draws its own heading only on the notes slice\'s templates page', () => {
    expect(desktopSettingsRoutes.filter((route) => route.ownHeading).map((route) => route.path)).toEqual(['/settings/note-templates']);
  });
});

describe('the settings code', () => {
  const dir = join(__dirname, '../../src/renderer/src/settings');
  const sources = readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

  it('has no hand-made settings stack of outlined cards', () => {
    expect(sources.filter(({ text }) => text.includes('Card variant="outlined"')).map(({ name }) => name)).toEqual([]);
  });

  it('reads no breakpoint (the hub\'s isCompactWindow is the one gate)', () => {
    expect(sources.filter(({ text }) => /useMediaQuery|\.breakpoints\b/.test(text)).map(({ name }) => name)).toEqual([]);
  });

  it('keeps the local SettingsPage and registry card stack deleted', () => {
    expect(sources.map(({ name }) => name)).not.toContain('SettingsPage.tsx');
    expect(sources.map(({ name }) => name)).not.toContain('registry.tsx');
  });

  it('renders no local key field: the key block is the platform\'s UserAiKeyCard', () => {
    const ai = sources.find(({ name }) => name === 'AiProviderCard.tsx')?.text ?? '';
    expect(ai).toContain('UserAiKeyCard');
    expect(ai).not.toMatch(/label="API key"/);
  });
});
