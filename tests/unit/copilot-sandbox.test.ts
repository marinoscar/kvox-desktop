import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeCopilotData } from '../../src/server/ai/copilot-data';
import { reapRuntimeProcesses } from '../../src/server/ai/copilot-process-reaper';
import { bundledRuntimePath, runtimeLauncherName } from '../../src/server/ai/copilot-runtime-location';
import { runningCopilotSandboxes, startCopilotRuntimeSandbox, stopCopilotSandboxes } from '../../src/server/ai/copilot-sandbox';
import { dataFolder } from '../../src/server/data-folder';

// =============================================================================
// The Copilot runtime sandbox: environment, lifecycle, no zombie, data hygiene
// (marinoscar/kvox-desktop#23)
// =============================================================================

const ALLOWED = ['api.githubcopilot.com', 'github.com', 'api.github.com'];
const dirs: string[] = [];
const children: ChildProcess[] = [];
const sandboxes: Array<{ stop(): Promise<void> }> = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kvox-copilot-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.stop();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function start(options: Partial<Parameters<typeof startCopilotRuntimeSandbox>[0]> = {}) {
  const lines: string[] = [];
  const sandbox = await startCopilotRuntimeSandbox({
    dataDirectory: join(tmp(), 'copilot'),
    allowedHosts: ALLOWED,
    log: (line) => lines.push(line),
    ...options,
  });
  sandboxes.push(sandbox);
  return { sandbox, lines };
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the runtime environment', () => {
  it('forces the child through the proxy, leaves nothing to bypass it and strips ambient credentials', async () => {
    const { sandbox } = await start({
      baseEnv: { PATH: '/bin', GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'x', COPILOT_GITHUB_TOKEN: 'y', ALL_PROXY: 'socks5://elsewhere', NO_PROXY: 'github.com', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com' },
    });
    const { env } = sandbox;
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) expect(env[name]).toBe(sandbox.proxyUrl);
    expect(sandbox.proxyUrl).toMatch(/^http:\/\/kvox:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
    expect(env.PATH).toBe('/bin');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'ALL_PROXY', 'OTEL_EXPORTER_OTLP_ENDPOINT']) expect(env[name], name).toBeUndefined();
    expect(env.COPILOT_OTEL_ENABLED).toBe('false');
    expect(env.OTEL_SDK_DISABLED).toBe('true');
    expect(env.DO_NOT_TRACK).toBe('1');
    expect(env.COPILOT_HOME).toMatch(/copilot[\\/]home$/);
  });

  it('puts the overrides into process.env on apply() and puts everything back on stop()', async () => {
    const before = { ...process.env };
    process.env.GH_TOKEN = 'ghp_ambient';
    process.env.NO_PROXY = 'localhost';
    try {
      const { sandbox } = await start({ baseEnv: process.env });
      sandbox.apply();
      sandbox.apply();
      expect(process.env.HTTPS_PROXY).toBe(sandbox.proxyUrl);
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(process.env.NO_PROXY).toBe('');
      await sandbox.stop();
      expect(process.env.HTTPS_PROXY).toBe(before.HTTPS_PROXY);
      expect(process.env.GH_TOKEN).toBe('ghp_ambient');
      expect(process.env.NO_PROXY).toBe('localhost');
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
      for (const [name, value] of Object.entries(before)) process.env[name] = value;
    }
  });

  it('never logs a token or the proxy credentials', async () => {
    const { sandbox, lines } = await start();
    await sandbox.stop();
    const text = lines.join('\n');
    expect(text).toContain('egress proxy on 127.0.0.1');
    expect(text).not.toContain(sandbox.proxyUrl);
    expect(text).not.toMatch(/kvox:[0-9a-f]{20}/);
  });
});

describe('the lifecycle', () => {
  it('has a proxy listener only while the sandbox runs', async () => {
    expect(runningCopilotSandboxes()).toHaveLength(0);
    const { sandbox } = await start();
    expect(runningCopilotSandboxes()).toEqual([sandbox]);
    expect(await listening(sandbox.port)).toBe(true);
    await sandbox.stop();
    expect(runningCopilotSandboxes()).toHaveLength(0);
    expect(await listening(sandbox.port)).toBe(false);
  });

  it('stops the runtime first, then the proxy, and stop() is idempotent', async () => {
    const order: string[] = [];
    const { sandbox } = await start({
      stopRuntime: async () => void order.push(`runtime stopped, proxy ${(await listening(portOf())) ? 'up' : 'down'}`),
    });
    const portOf = () => sandbox.port;
    await Promise.all([sandbox.stop(), sandbox.stop()]);
    expect(order).toEqual(['runtime stopped, proxy up']);
    expect(await listening(sandbox.port)).toBe(false);
  });

  it('stopCopilotSandboxes() (the server close, so the app quit) stops every sandbox', async () => {
    const a = await start();
    const b = await start();
    await stopCopilotSandboxes();
    expect(await listening(a.sandbox.port)).toBe(false);
    expect(await listening(b.sandbox.port)).toBe(false);
    expect(runningCopilotSandboxes()).toHaveLength(0);
  });
});

// A runtime that hangs: the SDK would not return from `stop`, and the process stays. The reaper looks
// for DIRECT children of this process whose command is the launcher, here a script named copilot-runtime.
describe.skipIf(process.platform === 'win32')('no zombie runtime after a hang', () => {
  function fakeRuntime(): ChildProcess {
    const dir = tmp();
    const launcher = join(dir, runtimeLauncherName());
    writeFileSync(launcher, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    chmodSync(launcher, 0o755);
    const child = spawn(launcher, ['--headless'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }
  const exited = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));

  it('kills a runtime that does not stop in time, and still closes the proxy', async () => {
    const runtime = fakeRuntime();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); // not the runtime
    children.push(other);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { sandbox, lines } = await start({ stopRuntime: () => new Promise<void>(() => undefined), stopTimeoutMs: 200 });
    await sandbox.stop();
    await exited(runtime);
    expect(alive(runtime.pid!)).toBe(false);
    expect(alive(other.pid!)).toBe(true); // only the runtime is touched
    expect(await listening(sandbox.port)).toBe(false);
    expect(lines.join('\n')).toContain('did not stop in 200 ms; killing it');
    expect(lines.join('\n')).toContain('killed 1 runtime process(es) left behind');
  });

  it('reaps a runtime nobody asked to stop, and does nothing when none is running', async () => {
    expect(await reapRuntimeProcesses()).toEqual([]);
    const runtime = fakeRuntime();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await reapRuntimeProcesses()).toEqual([runtime.pid]);
    await exited(runtime);
    expect(alive(runtime.pid!)).toBe(false);
  });

  it('only matches the launcher by file name, never by a lookalike', async () => {
    const killed: number[] = [];
    const found = await reapRuntimeProcesses({
      listChildren: async () => [
        { pid: 1, command: '/opt/x/copilot-runtime --headless' },
        { pid: 2, command: 'C:\\Users\\a\\copilot-runtime.exe --headless' },
        { pid: 3, command: '/usr/bin/my-copilot-runtime-notes' },
        { pid: 4, command: 'node server.js' },
      ],
      kill: async (pid) => void killed.push(pid),
    });
    expect(found).toEqual([1, 2]);
    expect(killed).toEqual([1, 2]);
  });
});

describe('Remove Copilot data', () => {
  function populated() {
    const folder = dataFolder(tmp());
    for (const path of ['home/session-state/s1/events.jsonl', 'home/auth/token.json', 'work/.keep', 'runtime/1.0.98/copilot-runtime', 'runtime/1.0.98/installed.json']) {
      mkdirSync(join(folder.copilot, path, '..'), { recursive: true });
      writeFileSync(join(folder.copilot, path), 'x');
    }
    writeFileSync(join(folder.root, 'settings.json'), '{}');
    return folder;
  }

  it('deletes the state and keeps the downloaded runtime', async () => {
    const folder = populated();
    const result = await removeCopilotData(folder);
    expect(result).toEqual({ removed: ['home', 'work'], keptRuntime: true });
    expect(existsSync(join(folder.copilot, 'home'))).toBe(false);
    expect(existsSync(join(folder.copilot, 'runtime', '1.0.98', 'copilot-runtime'))).toBe(true);
    expect(existsSync(join(folder.root, 'settings.json'))).toBe(true);
  });

  it('deletes the runtime too when asked, and is fine when there is nothing', async () => {
    const folder = populated();
    expect((await removeCopilotData(folder, { includeRuntime: true })).keptRuntime).toBe(false);
    expect(existsSync(folder.copilot)).toBe(false);
    expect(await removeCopilotData(folder)).toEqual({ removed: [], keptRuntime: false });
  });

  it('refuses a folder that is not <userData>/copilot', async () => {
    const folder = { ...dataFolder(tmp()), copilot: join(tmp(), 'vault') };
    await expect(removeCopilotData(folder)).rejects.toThrow(/not the Copilot data directory/);
  });
});

describe('the bundled runtime location', () => {
  it('is undefined for the default installer and the launcher for the with-copilot flavour', () => {
    expect(bundledRuntimePath('/app/resources', 'linux', () => false)).toBeUndefined();
    expect(bundledRuntimePath(undefined, 'linux', () => true)).toBeUndefined();
    expect(bundledRuntimePath('/app/resources', 'linux', (path) => path === join('/app/resources', 'copilot', 'copilot-runtime'))).toBe(join('/app/resources', 'copilot', 'copilot-runtime'));
    expect(bundledRuntimePath('C:\\r', 'win32', () => true)).toMatch(/copilot-runtime\.exe$/);
  });
});
