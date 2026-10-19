import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// =============================================================================
// No zombie runtime (marinoscar/kvox-desktop#23)
// =============================================================================
//
// The SDK spawns the Copilot runtime itself, so this process does not hold its
// handle. After the host asked the runtime to stop (and after a hang, a crash
// of a call, or a timeout), the sandbox looks for direct children of this very
// process whose command is the runtime launcher (`copilot-runtime`,
// `copilot-runtime.exe`) and kills what is left. Only DIRECT children of this
// process are ever touched.
//
// If this process itself dies without running any shutdown hook (SIGKILL), the
// runtime, which talks to the SDK over stdio, sees its pipes close and exits;
// the main process also stops the server on `before-quit`
// (src/main/index.ts), which runs the sandbox's `stop()`.
// =============================================================================

const run = promisify(execFile);

/** A process found under this one. */
export interface ChildProcessInfo {
  pid: number;
  command: string;
}

/** Options of {@link reapRuntimeProcesses}. */
export interface ReapOptions {
  /** Which commands are the runtime. Default: the launcher's file name. */
  commandMatch?: RegExp;
  /** Direct children of `parentPid`. Default: `ps` (POSIX) or PowerShell (Windows). */
  listChildren?: (parentPid: number) => Promise<ChildProcessInfo[]>;
  /** Kills one process (and, on Windows, its tree). Default: SIGKILL / `taskkill`. */
  kill?: (pid: number) => Promise<void>;
  /** The parent whose children are looked at. Default: this process. */
  parentPid?: number;
}

/** The runtime launcher's file name, in a command line. */
export const RUNTIME_COMMAND = /(^|[\\/\s"])copilot-runtime(\.exe)?(["\s]|$)/;

/** Direct children of `parentPid`, by asking the OS. */
async function osChildren(parentPid: number): Promise<ChildProcessInfo[]> {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    return parseLines(stdout);
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 });
  const found: ChildProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === parentPid) found.push({ pid: Number(match[1]), command: match[3] as string });
  }
  return found;
}

function parseLines(stdout: string): ChildProcessInfo[] {
  const found: ChildProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) found.push({ pid: Number(match[1]), command: match[2] as string });
  }
  return found;
}

async function osKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

/** Kills the runtime processes still running under this process. Returns their pids. Never throws. */
export async function reapRuntimeProcesses(options: ReapOptions = {}): Promise<number[]> {
  const match = options.commandMatch ?? RUNTIME_COMMAND;
  const list = options.listChildren ?? osChildren;
  const kill = options.kill ?? osKill;
  const killed: number[] = [];
  let children: ChildProcessInfo[] = [];
  try {
    children = await list(options.parentPid ?? process.pid);
  } catch {
    return killed;
  }
  for (const child of children) {
    if (!match.test(child.command)) continue;
    try {
      await kill(child.pid);
      killed.push(child.pid);
    } catch {
      // Already gone.
    }
  }
  return killed;
}
