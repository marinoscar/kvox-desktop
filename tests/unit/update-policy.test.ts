import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readShellSettings, writeShellSettings } from '../../src/main/shell-settings';
import { UPDATE_HOSTS, allowedUpdateHosts, testFeedUrl, updateRequestAllowed } from '../../src/main/update-policy';

// =============================================================================
// Opt-in updates: what the updater may reach, in both states (marinoscar/kvox#587)
// =============================================================================
//
// ADR-0004: no outbound traffic unless the user turns on "Check for updates".
// Off (the default, and whatever a missing or damaged settings.json says), the
// updater's session may reach nothing, GitHub included. On, it may reach the
// GitHub Releases hosts over HTTPS only. tests/e2e/updates.spec.ts proves the
// same against the packaged app with a loopback feed.
// =============================================================================

const RELEASE_URLS = [
  'https://github.com/marinoscar/kvox-desktop/releases.atom',
  'https://github.com/marinoscar/kvox-desktop/releases/download/v0.1.0/latest.yml',
  'https://api.github.com/repos/marinoscar/kvox-desktop/releases/latest',
  'https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Signature=x',
  'https://release-assets.githubusercontent.com/github-production-release-asset/1/2',
];

describe('updateRequestAllowed', () => {
  it('allows nothing while updates are off, GitHub included', () => {
    expect(allowedUpdateHosts(false)).toEqual([]);
    for (const url of [...RELEASE_URLS, 'http://127.0.0.1:8080/latest.yml', 'https://example.com/']) {
      expect(updateRequestAllowed(url, false), url).toBe(false);
    }
  });

  it('allows the GitHub Releases hosts over HTTPS once updates are on', () => {
    expect(allowedUpdateHosts(true)).toEqual(UPDATE_HOSTS);
    for (const url of RELEASE_URLS) expect(updateRequestAllowed(url, true), url).toBe(true);
  });

  it('refuses every other host, plain HTTP to GitHub and junk, even when on', () => {
    for (const url of [
      'https://example.com/latest.yml',
      'https://github.com.evil.example/latest.yml',
      'https://raw.githubusercontent.com/marinoscar/kvox-desktop/main/x',
      'http://github.com/marinoscar/kvox-desktop/releases.atom',
      'ftp://github.com/x',
      'not a url',
    ]) {
      expect(updateRequestAllowed(url, true), url).toBe(false);
    }
  });

  it('allows a loopback feed when on (the e2e tests)', () => {
    expect(updateRequestAllowed('http://127.0.0.1:4567/latest.yml', true)).toBe(true);
    expect(updateRequestAllowed('http://localhost:4567/latest.yml', true)).toBe(true);
  });
});

describe('testFeedUrl', () => {
  it('honours a loopback feed only', () => {
    expect(testFeedUrl({})).toBeNull();
    expect(testFeedUrl({ KVOX_UPDATE_FEED_URL: 'http://127.0.0.1:4567/' })).toBe('http://127.0.0.1:4567/');
    expect(testFeedUrl({ KVOX_UPDATE_FEED_URL: 'http://[::1]:4567/' })).toBe('http://[::1]:4567/');
    expect(testFeedUrl({ KVOX_UPDATE_FEED_URL: 'https://updates.example.com/' })).toBeNull();
    expect(testFeedUrl({ KVOX_UPDATE_FEED_URL: 'file:///tmp/feed' })).toBeNull();
    expect(testFeedUrl({ KVOX_UPDATE_FEED_URL: 'junk' })).toBeNull();
  });
});

describe('the "Check for updates" setting', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('is off without a settings file, with a damaged one and with anything but true', () => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-settings-'));
    const path = join(dir, 'settings.json');
    expect(readShellSettings(path).updates.checkForUpdates).toBe(false);
    writeFileSync(path, '{ not json');
    expect(readShellSettings(path).updates.checkForUpdates).toBe(false);
    writeFileSync(path, JSON.stringify({ updates: { checkForUpdates: 'yes' } }));
    expect(readShellSettings(path).updates.checkForUpdates).toBe(false);
  });

  it('keeps the user\'s choice, and the other settings beside it', () => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-settings-'));
    const path = join(dir, 'settings.json');
    const settings = readShellSettings(path);
    settings.secrets.allowPlaintext = true;
    settings.updates.checkForUpdates = true;
    writeShellSettings(path, settings);
    expect(readShellSettings(path)).toEqual({
      secrets: { allowPlaintext: true },
      updates: { checkForUpdates: true },
      themeMode: 'system',
      shell: { railCollapsed: false },
    });
    settings.updates.checkForUpdates = false;
    writeShellSettings(path, settings);
    expect(readShellSettings(path).updates.checkForUpdates).toBe(false);
  });
});
