import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';

import { PgTableJobs } from '../../src/server/ports/pg-table-jobs';
import { ROOT, openTestDatabase, removeQuietly, type TestDatabase } from './support/database';

// =============================================================================
// A job running when the process is killed resumes on the next start (marinoscar/kvox#583)
// =============================================================================
//
// A real kill: a child process (tests/crash/hang-mid-job.child.ts) opens a
// PGlite data folder, starts the job loop and claims a job that never ends; the
// moment the job is running, the child is killed with SIGKILL (on Windows,
// TerminateProcess). Then this process opens the same folder, as the next
// launch does: PGlite recovers from the unclean stop, `recoverInterrupted`
// puts the orphaned `running` row back, and the job runs to completion. No
// row is left `running`.
// =============================================================================

const CRASH_JOB_TYPE = 'desktop.test.crash';
const dir = mkdtempSync(join(tmpdir(), 'kvox-crash-'));
let child: ChildProcess | undefined;
let db: TestDatabase | undefined;

afterAll(async () => {
  child?.kill('SIGKILL');
  await db?.close({ keepFolder: true });
  removeQuietly(dir);
});

async function until(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it('a job running when the process is killed runs again on the next start, leaving no running row', async () => {
  let output = '';
  child = spawn(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'tests/crash/vitest.config.mts'], {
    cwd: ROOT,
    env: { ...process.env, KVOX_CRASH_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));

  const marker = join(dir, 'running.json');
  await until(() => existsSync(marker) || child!.exitCode !== null, 240_000, `the job to start\n${output}`);
  expect(existsSync(marker), output).toBe(true);
  const { jobId, pid } = JSON.parse(readFileSync(marker, 'utf8')) as { jobId: string; pid: number };
  expect(pid).toBe(child.pid);

  child.kill('SIGKILL');
  await exited;

  // The next launch.
  db = await openTestDatabase(dir);
  const before = await db.prisma.$queryRawUnsafe<Array<{ status: string; attempts: number }>>(
    `SELECT status::text AS status, attempts FROM jobs WHERE id = $1::uuid`,
    jobId,
  );
  expect(before[0]).toEqual({ status: 'running', attempts: 1 });

  const jobs = new PgTableJobs(db.prisma, { dataDir: dir, orgId: db.orgId, log: () => undefined });
  const ran: Array<{ id: string; attempts: number }> = [];
  jobs.registerHandler({
    type: CRASH_JOB_TYPE,
    profile: { maxRuntimeMs: 60_000, maxAttempts: 2 },
    process: async (job) => void ran.push({ id: job.id, attempts: job.attempts }),
  });
  expect(await jobs.recoverInterrupted()).toEqual({ requeued: 1, failed: 0 });
  await jobs.drain();
  await jobs.stop();

  expect(ran).toEqual([{ id: jobId, attempts: 2 }]);
  const after = await db.prisma.$queryRawUnsafe<Array<{ status: string; last_error: string | null }>>(
    `SELECT status::text AS status, last_error FROM jobs WHERE id = $1::uuid`,
    jobId,
  );
  expect(after[0]).toEqual({ status: 'succeeded', last_error: null });
  const running = await db.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`);
  expect(running[0].n).toBe(0);
});
