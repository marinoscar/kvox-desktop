import { randomBytes } from 'node:crypto';
import { join, normalize, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, Notification, app, dialog, ipcMain, net, protocol, session, utilityProcess, type UtilityProcess } from 'electron';

import type { DesktopConnection, FromServer, ToServer } from '../shared/protocol';
import { registerImportIpc } from './import';
import { runSecretOp, secretStorageStatus } from './secret-storage';
import { readShellSettings, writeShellSettings } from './shell-settings';

// =============================================================================
// The Electron main process of KVox Desktop (marinoscar/kvox#582)
// =============================================================================
//
// It owns three things and nothing of the domain:
//
//   1. THE SERVER: a utility process (`out/main/server.js`) running Nest on
//      Fastify over PGlite on 127.0.0.1, port chosen by the system. It gets a
//      random per-launch token in a message; only this process and its own
//      window ever hold it.
//   2. THE WINDOW: sandboxed, context-isolated, no Node. The renderer is served
//      from the `kvox://app` scheme (or the dev server); the preload exposes one
//      call, `kvoxDesktop.connection()`, answering the port and the token.
//   3. THE EGRESS GUARD: every request the window's session makes to anything but
//      loopback, `kvox:`, `file:` (the `kvox:` handler reads the app's own files),
//      `data:`, `blob:` or `devtools:` is cancelled, counted and logged at error
//      level with the host only (ADR-0004: the AI provider, called from the
//      server, is the only egress; the server has its own guard,
//      `src/server/egress-guard.ts`).
//   4. WHAT ONLY THIS PROCESS HAS, for the server (marinoscar/kvox#583):
//      `safeStorage` for its secrets port, `Notification` for its notify port,
//      and a restart of the server after a restore was staged (the window
//      reloads onto the new server). For the window: the native backup dialogs
//      and the plaintext-secrets consent (`settings.json`).
//   5. IMPORT (marinoscar/kvox#585): the native "Import…" dialog and files
//      dropped on the window are read here and streamed to the local server's
//      upload routes (`import.ts`); the window never reads a file itself.
//
// The user data folder is `app.getPath('userData')` (KVox under the OS's
// application-data folder). `KVOX_USER_DATA_DIR` overrides it, for tests.
// =============================================================================

const launchedAt = performance.now();
const APP_ORIGIN = 'kvox://app';

if (process.env.KVOX_USER_DATA_DIR) app.setPath('userData', process.env.KVOX_USER_DATA_DIR);

protocol.registerSchemesAsPrivileged([
  { scheme: 'kvox', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let server: UtilityProcess | undefined;
let connection: Promise<DesktopConnection> | undefined;
let stopping: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;

function log(line: string): void {
  console.log(`[kvox] ${line}`);
}

function logError(line: string): void {
  console.error(`[kvox] ERROR ${line}`);
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');

/** The renderer's origin: the dev server's in `electron-vite dev`, else `kvox://app`. */
function rendererOrigin(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl ? new URL(devUrl).origin : APP_ORIGIN;
}

/** Starts the server utility process and resolves once it listens. */
function startServer(): Promise<DesktopConnection> {
  const token = randomBytes(32).toString('base64url');
  const child = utilityProcess.fork(join(__dirname, 'server.js'), [], {
    serviceName: 'KVox server',
    stdio: 'inherit',
  });
  server = child;

  return new Promise((resolve, reject) => {
    child.on('message', (message: FromServer) => {
      if (message.type === 'log') (message.level === 'error' ? logError : log)(`server: ${message.line.replace(/^server: /, '')}`);
      else if (message.type === 'secrets') {
        let reply: ToServer;
        try {
          reply = { type: 'secrets-result', id: message.id, ok: true, value: runSecretOp(message, settingsPath()) };
        } catch (error) {
          reply = { type: 'secrets-result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        child.postMessage(reply);
      } else if (message.type === 'notify') {
        if (Notification.isSupported()) new Notification({ title: message.title, body: message.body }).show();
      } else if (message.type === 'restart') {
        void restartServer(message.reason);
      } else if (message.type === 'ready') {
        log(`server ready on 127.0.0.1:${message.port} after ${Math.round(performance.now() - launchedAt)} ms since launch`);
        resolve({ baseUrl: `http://127.0.0.1:${message.port}`, token, userId: message.userId, permissions: message.permissions });
      } else if (message.type === 'error') {
        log(`server failed to start:\n${message.message}`);
        reject(new Error(message.message));
      }
    });
    child.on('exit', (code) => {
      if (server === child) server = undefined;
      if (!stopping) {
        log(`server exited unexpectedly (code ${code})`);
        reject(new Error(`The local server exited (code ${code})`));
        app.exit(1);
      }
    });
    const start: ToServer = {
      type: 'start',
      appRoot: app.getAppPath(),
      userDataDir: app.getPath('userData'),
      nodeExecutable: process.execPath,
      token,
      allowedOrigins: [rendererOrigin()],
      appVersion: app.getVersion(),
    };
    child.postMessage(start);
  });
}

/** Asks the server to close (flushing PGlite) and waits for it, at most 15 s. */
function stopServer(): Promise<void> {
  if (stopping) return stopping;
  const child = server;
  stopping = new Promise<void>((resolve) => {
    if (!child) return resolve();
    const timer = setTimeout(() => {
      log('server did not stop in 15 s; killing it');
      child.kill();
      resolve();
    }, 15_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'stop' } satisfies ToServer);
  });
  return stopping;
}

let restarting = false;

/** Stops the server and starts a new one (a restore is staged), then reloads the window onto it. */
async function restartServer(reason: string): Promise<void> {
  if (restarting) return;
  restarting = true;
  log(`restarting the server: ${reason}`);
  try {
    await stopServer();
    stopping = undefined;
    connection = startServer();
    await connection.catch(() => undefined);
    mainWindow?.webContents.reload();
  } finally {
    restarting = false;
  }
}

/** Serves `out/renderer` at `kvox://app/`, falling back to index.html for client routes. */
function registerAppProtocol(): void {
  const root = join(__dirname, '../renderer');
  protocol.handle('kvox', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const path = normalize(join(root, decodeURIComponent(url.pathname)));
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(path).toString()).catch(() => undefined);
    if (response?.ok) return response;
    return net.fetch(pathToFileURL(join(root, 'index.html')).toString());
  });
}

let windowEgressBlocked = 0;

/** Cancels every request of the default session that is not local; logs the host only. */
function installEgressGuard(): void {
  const devHost = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).hostname : null;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const local =
      ['kvox:', 'file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:'].includes(url.protocol) ||
      url.hostname === '127.0.0.1' ||
      (devHost !== null && url.hostname === devHost);
    if (!local) {
      windowEgressBlocked += 1;
      logError(`window: egress blocked: ${url.hostname || url.protocol} (${windowEgressBlocked} blocked since start-up)`);
    }
    callback({ cancel: !local });
  });
}

/** The window's requests to the shell besides the connection. */
function registerShellIpc(): void {
  ipcMain.handle('kvox:data-folder', () => app.getPath('userData'));
  ipcMain.handle('kvox:choose-backup-target', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const options = {
      title: 'Export data',
      defaultPath: join(app.getPath('documents'), `KVox-${stamp}.kvoxbackup`),
      filters: [{ name: 'KVox backup', extensions: ['kvoxbackup'] }],
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  });
  ipcMain.handle('kvox:choose-backup-source', async () => {
    const options = {
      title: 'Restore data',
      properties: ['openFile' as const],
      filters: [{ name: 'KVox backup', extensions: ['kvoxbackup'] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('kvox:secret-storage', () => secretStorageStatus(settingsPath()));
  ipcMain.handle('kvox:accept-plaintext-secrets', (_event, accepted: unknown) => {
    const settings = readShellSettings(settingsPath());
    settings.secrets.allowPlaintext = accepted === true;
    writeShellSettings(settingsPath(), settings);
    log(`secrets: plaintext storage ${settings.secrets.allowPlaintext ? 'accepted' : 'withdrawn'} by the user`);
    return secretStorageStatus(settingsPath());
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'KVox',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The spellchecker downloads dictionaries from a Google CDN on Windows and Linux.
      spellcheck: false,
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => {
    log(`window ready after ${Math.round(performance.now() - launchedAt)} ms since launch`);
    window.show();
  });
  // No other page, no pop-up: links to the outside are not followed.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== rendererOrigin()) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadURL(`${APP_ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  // PGlite has one writer: a second instance would open the same data folder.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  ipcMain.handle('kvox:connection', () => connection);
  registerShellIpc();
  registerImportIpc({ window: () => mainWindow, connection: () => connection, log });

  void app.whenReady().then(() => {
    installEgressGuard();
    registerAppProtocol();
    connection = startServer();
    connection.catch(() => undefined);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (!server || stopping) return;
    event.preventDefault();
    void stopServer().finally(() => app.quit());
  });
}
