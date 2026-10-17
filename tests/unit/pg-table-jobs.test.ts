import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KvoxRateLimitError } from '@marinoscar/kvox-api/ports';

import { INTERRUPTED_ERROR, KvoxJobTimeoutError, PgTableJobs } from '../../src/server/ports/pg-table-jobs';
import { openTestDatabase, type TestDatabase } from './support/database';

// =============================================================================
// What Desktop added to the bare host's job runner (marinoscar/kvox#583)
// =============================================================================
//
// `maxRuntimeMs`, the back-off between attempts, crash recovery of `running`
// rows and the rate-limit deferral, over a real `jobs` table. The real kill of
// a process mid-job is `jobs-crash-recovery.test.ts`.
// =============================================================================

let db: TestDatabase;
let counter = 0;
const uniqueType = (label: string) => `desktop.test.${label}.${Date.now().toString(36)}.${(counter += 1)}`;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

function runner(options: { backoffBaseMs?: number } = {}): PgTableJobs {
  return new PgTableJobs(db.prisma, { dataDir: db.userDataDir, orgId: db.orgId, log: () => undefined, ...options });
}

async function row(id: string) {
  const rows = await db.prisma.$queryRawUnsafe<Array<{ status: string; attempts: number; last_error: string | null; scheduled_for: Date | null }>>(
    `SELECT status::text AS status, attempts, last_error, scheduled_for FROM jobs WHERE id = $1::uuid`,
    id,
  );
  return rows[0];
}

describe('PgTableJobs (Desktop)', () => {
  it('fails an attempt that outlives maxRuntimeMs, aborts its signal and moves on', async () => {
    const jobs = runner();
    const type = uniqueType('timeout');
    let aborted: unknown;
    jobs.registerHandler({
      type,
      profile: { maxRuntimeMs: 200, maxAttempts: 1 },
      process: (job) =>
        new Promise<void>((resolve) => {
          const signal = (job as { signal?: AbortSignal }).signal;
          signal?.addEventListener('abort', () => (aborted = signal.reason));
          setTimeout(resolve, 60_000).unref();
        }),
    });
    const settled: string[] = [];
    jobs.onSettled((event) => event.type === type && settled.push(`${event.status}:${event.lastError}`));
    const { id } = await jobs.enqueue({ type, payload: {} });
    const started = Date.now();
    expect(await jobs.drain()).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(aborted).toBeInstanceOf(KvoxJobTimeoutError);
    expect(await row(id)).toMatchObject({ status: 'failed' });
    expect(settled).toEqual([expect.stringMatching(/^failed:Job .* ran longer than its limit of 200 ms$/)]);
  });

  it('waits a growing back-off between failed attempts', async () => {
    const jobs = runner({ backoffBaseMs: 60_000 });
    const type = uniqueType('backoff');
    let calls = 0;
    jobs.registerHandler({
      type,
      profile: { maxRuntimeMs: 10_000, maxAttempts: 3 },
      async process() {
        calls += 1;
        throw new Error('boom');
      },
    });
    const { id } = await jobs.enqueue({ type, payload: {} });
    await jobs.drain();
    // One attempt, then the job is pending but not due for a minute: drain does not retry it.
    expect(calls).toBe(1);
    const first = await row(id);
    expect(first).toMatchObject({ status: 'pending', attempts: 1, last_error: 'boom' });
    expect(first.scheduled_for!.getTime() - Date.now()).toBeGreaterThan(50_000);
    // Fast-forward: the second wait is twice the first.
    await jobs.drain({ ignoreSchedule: true, untilIdle: false });
    const second = await row(id);
    expect(second.attempts).toBe(2);
    expect(second.scheduled_for!.getTime() - Date.now()).toBeGreaterThan(110_000);
    await jobs.drain({ ignoreSchedule: true, untilIdle: false });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('defers a rate-limited attempt without spending it', async () => {
    const jobs = runner();
    const type = uniqueType('ratelimit');
    jobs.registerHandler({
      type,
      async process() {
        throw new KvoxRateLimitError('provider:user', 30_000);
      },
    });
    const { id } = await jobs.enqueue({ type, payload: {} });
    await jobs.drain();
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('recovers the running rows a dead process left: requeued with attempts left, failed and settled without', async () => {
    const type = uniqueType('recover');
    const crashed = runner();
    crashed.registerHandler({ type, profile: { maxRuntimeMs: 60_000, maxAttempts: 2 }, process: () => new Promise<void>(() => undefined) });
    const retryable = await crashed.enqueue({ type, subjectType: 'thing', subjectId: 'a', payload: {} });
    const spent = await crashed.enqueue({ type, subjectType: 'thing', subjectId: 'b', payload: {} });
    // As a killed process leaves them: claimed (running), one on its last attempt.
    await db.prisma.$executeRawUnsafe(`UPDATE jobs SET status = 'running', attempts = 1, started_at = now() WHERE id = $1::uuid`, retryable.id);
    await db.prisma.$executeRawUnsafe(`UPDATE jobs SET status = 'running', attempts = 2, started_at = now() WHERE id = $1::uuid`, spent.id);

    const next = runner();
    let ran = 0;
    next.registerHandler({ type, profile: { maxRuntimeMs: 60_000, maxAttempts: 2 }, process: async () => void (ran += 1) });
    const settled: Array<{ jobId: string; status: string; lastError: string | null }> = [];
    next.onSettled((event) => event.type === type && settled.push({ jobId: event.jobId, status: event.status, lastError: event.lastError }));

    expect(await next.recoverInterrupted()).toEqual({ requeued: 1, failed: 1 });
    expect(await row(spent.id)).toMatchObject({ status: 'failed', last_error: INTERRUPTED_ERROR });
    expect(settled).toEqual([{ jobId: spent.id, status: 'failed', lastError: INTERRUPTED_ERROR }]);
    expect(await row(retryable.id)).toMatchObject({ status: 'pending', attempts: 1 });

    await next.drain();
    expect(ran).toBe(1);
    expect(await row(retryable.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    const running = await db.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`);
    expect(running[0].n).toBe(0);
  });

  it('describes a job for the host routes', async () => {
    const jobs = runner();
    const type = uniqueType('describe');
    jobs.registerHandler({ type, async process() {} });
    const { id } = await jobs.enqueue({ type, payload: {} });
    expect(await jobs.describeJob(id)).toMatchObject({ id, type, status: 'pending', attempts: 0, lastError: null });
    expect(await jobs.describeJob('not-a-uuid')).toBeNull();
  });
});
