import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { PgTableJobs } from '../../src/server/ports/pg-table-jobs';
import { openTestDatabase } from '../unit/support/database';

// Run by tests/unit/jobs-crash-recovery.test.ts, never on its own: opens the
// database in KVOX_CRASH_DIR, starts the job loop like the server does, and the
// job it enqueued writes `running.json` and never finishes. The parent then
// kills this process (SIGKILL: no shutdown hook, PGlite not closed).

const CRASH_JOB_TYPE = 'desktop.test.crash';

it('runs a job until the process is killed', async () => {
  const dir = process.env.KVOX_CRASH_DIR;
  if (!dir) throw new Error('KVOX_CRASH_DIR is not set');
  const db = await openTestDatabase(dir);
  const jobs = new PgTableJobs(db.prisma, { dataDir: dir, orgId: db.orgId, log: () => undefined });
  jobs.registerHandler({
    type: CRASH_JOB_TYPE,
    profile: { maxRuntimeMs: 600_000, maxAttempts: 2 },
    process: (job) =>
      new Promise<void>(() => {
        writeFileSync(join(dir, 'running.json'), JSON.stringify({ jobId: job.id, pid: process.pid }));
      }),
  });
  await jobs.recoverInterrupted();
  await jobs.enqueue({ type: CRASH_JOB_TYPE, subjectType: 'crash', subjectId: '1', payload: { n: 1 } });
  jobs.start(50);
  await new Promise(() => undefined);
});
