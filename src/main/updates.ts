import { app, session } from 'electron';
import type { AppUpdater, UpdateInfo } from 'electron-updater';

import type { UpdateStatus } from '../shared/protocol';
import { readShellSettings, writeShellSettings } from './shell-settings';
import { UPDATE_HOSTS, testFeedUrl, updateRequestAllowed } from './update-policy';

// =============================================================================
// Opt-in updates (marinoscar/kvox#587, ADR-0004)
// =============================================================================
//
// OFF BY DEFAULT. Until the user turns on "Check for updates" (Settings,
// `settings.json` -> updates.checkForUpdates), `electron-updater` is not even
// loaded and the session it would use ("electron-updater") cancels every
// request. Turned on, it checks GitHub Releases at once and every six hours,
// downloads a newer version in the background and installs it when KVox quits
// (or at once, from the settings card). Its session may then reach the hosts of
// `update-policy.ts` only. Turned off again, the timer stops and the session
// is closed again.
//
// Signatures: electron-updater refuses an update whose Windows Authenticode
// publisher differs from the running app's (`publisherName` in
// app-update.yml) and macOS refuses one whose code signature does not match
// (Squirrel.Mac); the .deb and AppImage are checked against the SHA-512 of
// `latest-linux.yml`. Unsigned builds therefore do not update on Windows or
// macOS, by design.
// =============================================================================

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATER_PARTITION = 'electron-updater';

export interface DesktopUpdatesOptions {
  settingsPath: string;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export class DesktopUpdates {
  private enabled = false;
  private updater: AppUpdater | undefined;
  private timer: NodeJS.Timeout | undefined;
  private current: UpdateStatus;

  constructor(private readonly options: DesktopUpdatesOptions) {
    this.current = { enabled: false, state: 'off', currentVersion: app.getVersion() };
  }

  /** At `ready`: guards the updater's session, then starts checking if the user turned updates on. */
  start(): void {
    session.fromPartition(UPDATER_PARTITION, { cache: false }).webRequest.onBeforeRequest((details, callback) => {
      const allowed = updateRequestAllowed(details.url, this.enabled);
      if (!allowed) this.options.logError(`updates: egress blocked: ${hostOf(details.url)}`);
      callback({ cancel: !allowed });
    });
    const enabled = readShellSettings(this.options.settingsPath).updates.checkForUpdates;
    if (enabled) void this.turnOn();
    else this.options.log('updates: off (the user has not turned on "Check for updates"; no update request is made)');
  }

  status(): UpdateStatus {
    return { ...this.current };
  }

  /** Records the user's choice and applies it at once (a check runs in the background). */
  setEnabled(enabled: boolean): UpdateStatus {
    const settings = readShellSettings(this.options.settingsPath);
    settings.updates.checkForUpdates = enabled;
    writeShellSettings(this.options.settingsPath, settings);
    if (enabled) void this.turnOn();
    else this.turnOff();
    return this.status();
  }

  /** Quits and installs a downloaded update. */
  installNow(): void {
    if (this.current.state === 'downloaded') this.updater?.quitAndInstall();
  }

  private async turnOn(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.set({ state: 'idle' });
    this.options.log(`updates: on, allowing ${UPDATE_HOSTS.join(', ')} for the updater`);
    try {
      const updater = await this.load();
      if (!this.enabled) return;
      this.timer = setInterval(() => void this.check(updater), CHECK_EVERY_MS);
      this.timer.unref();
      await this.check(updater);
    } catch (error) {
      this.fail(error);
    }
  }

  private turnOff(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
    this.set({ state: 'off', version: undefined, message: undefined });
    this.options.log('updates: off');
  }

  private async check(updater: AppUpdater): Promise<void> {
    if (!this.enabled) return;
    // A failed check also emits `error`, which reports it.
    await updater.checkForUpdates().catch(() => undefined);
  }

  /** Loads electron-updater once, the first time updates are turned on. */
  private async load(): Promise<AppUpdater> {
    if (this.updater) {
      this.updater.autoInstallOnAppQuit = true;
      return this.updater;
    }
    // CommonJS: its `autoUpdater` getter is not a named export of the ESM namespace, only of `default`.
    const loaded = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') };
    const autoUpdater = loaded.default?.autoUpdater ?? loaded.autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = /-/.test(app.getVersion());
    autoUpdater.logger = {
      info: (message?: unknown) => this.options.log(`updates: ${String(message)}`),
      warn: (message?: unknown) => this.options.log(`updates: ${String(message)}`),
      error: (message?: unknown) => this.options.logError(`updates: ${String(message)}`),
      debug: () => undefined,
    };
    const feed = testFeedUrl(process.env);
    if (feed) {
      // The e2e tests' loopback feed; production reads app-update.yml (GitHub, with the publisher name).
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
      if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
      this.options.log('updates: using the loopback test feed');
    }
    autoUpdater.on('checking-for-update', () => this.enabled && this.set({ state: 'checking', message: undefined }));
    autoUpdater.on('update-not-available', () => this.enabled && this.set({ state: 'up-to-date', version: undefined }));
    autoUpdater.on('update-available', (info: UpdateInfo) => this.enabled && this.set({ state: 'downloading', version: info.version }));
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.enabled && this.set({ state: 'downloaded', version: info.version }));
    autoUpdater.on('error', (error: Error) => this.fail(error));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  private fail(error: unknown): void {
    if (!this.enabled) return;
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    this.options.logError(`updates: ${message}`);
    this.set({ state: 'error', message });
  }

  private set(change: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...change, enabled: this.enabled };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || new URL(url).protocol;
  } catch {
    return 'an invalid URL';
  }
}
