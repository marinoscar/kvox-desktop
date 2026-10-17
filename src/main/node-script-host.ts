import { createRequire } from 'node:module';

// =============================================================================
// The entry of a migration utility process (marinoscar/kvox#587)
// =============================================================================
//
// `utilityProcess.fork(node-script-host.js, [script, ...args])`. It runs the
// script as `node script ...args` would: same `process.argv`, loaded with
// `require` (both migration CLIs are CommonJS), from inside `app.asar`.
//
// A utility process does NOT end when its event loop drains (Node's
// `beforeExit` never fires there), and the Prisma CLI ends by draining after a
// successful `migrate deploy`. So this host ends the process itself once Node
// holds no handle or request beyond its own stdout and stderr pipes
// (`process.getActiveResourcesInfo()` lists the sockets, child processes, file
// requests and timers that keep a Node process alive), twice in a row, with
// the exit code the script set.
// =============================================================================

const POLL_MS = 100;

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('node-script-host: no script given');
  process.exit(2);
}
process.argv = [process.argv[0], script, ...args];

/** Resource names and how many of each. */
function census(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

// The baseline: stdout and stderr, opened first (their handles are created on first use).
void process.stdout;
void process.stderr;
const baseline = census(process.getActiveResourcesInfo());

/** True when nothing but the baseline keeps the process alive. */
function idle(): boolean {
  for (const [name, count] of census(process.getActiveResourcesInfo())) if (count > (baseline.get(name) ?? 0)) return false;
  return true;
}

let idleTicks = 0;
// Unref'd, so it is never one of the resources it waits for.
setInterval(() => {
  idleTicks = idle() ? idleTicks + 1 : 0;
  if (idleTicks >= 2) process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
}, POLL_MS).unref();

createRequire(script)(script);
