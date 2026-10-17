// From marinoscar/kvox examples/bare-host/src/ports/pg-table-jobs.ts (kvox commit in vendor/kvox/SOURCE.json). A host binding.
// Desktop adds what the bare host left out (marinoscar/kvox#583): see "WHAT DESKTOP ADDS" below.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import {
  KvoxRateLimitError,
  type KvoxActiveJob,
  type KvoxActiveJobQuery,
  type KvoxEnqueueInput,
  type KvoxEnqueueResult,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobSettledEvent,
  type KvoxJobSnapshot,
  type KvoxJobsPort,
} from '@marinoscar/kvox-api/ports';

// =============================================================================
// PgTableJobs: KVOX_JOBS as an in-process runner over the platform `jobs` table
// =============================================================================
//
// What KVox Desktop takes as a starting point. The domain tables reference
// `jobs.id` (`kg_proposals.job_id`, `ask_messages.job_id`, `kg_exports.job_id`,
// ...), so a job must be a REAL row of the platform's table, not an in-memory
// object. This class inserts those rows and then runs the handlers itself, in
// this process, with no lease, no heartbeat and no worker node.
//
// THE COLUMNS A HOST MUST FILL (platform `jobs`, NOT NULL and without a database
// default): `id` (the Prisma client generates the uuid, so raw SQL supplies it),
// `type`, `reason`. Everything else has a default or is nullable. `dedup_key`
// is `type:subjectType:subjectId`, and the platform's PARTIAL UNIQUE INDEX
// `jobs_active_dedup_uniq_idx` (one row per key while `pending` or `running`)
// is what makes the dedup atomic: `INSERT ... ON CONFLICT DO NOTHING`, no
// check-then-insert race.
//
// CLAIMING is one statement (`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
// LOCKED LIMIT 1) RETURNING`), run outside any transaction, so a handler never
// runs while this class holds a transaction. That matters on PGlite, which has
// ONE session: a handler that queries the pool while a transaction is open on
// the pool's only connection would wait forever.
//
// WHAT DESKTOP ADDS (the bare host left these to the host; the platform queue
// has a lease and a reaper for them):
//
//   - `maxRuntimeMs`: an attempt that outlives its profile's limit (default
//     {@link DEFAULT_MAX_RUNTIME_MS}) fails with a timeout, its `AbortSignal`
//     (`job.signal`, for a handler that looks) is aborted, and the drain moves
//     on. A handler that ignores the signal keeps running detached; its outcome
//     is discarded.
//   - BACK-OFF: a failed attempt that has attempts left waits
//     `base * 2^(attempts-1)` (capped) before it is claimable again.
//   - CRASH RECOVERY: {@link PgTableJobs.recoverInterrupted}, called once at
//     start-up before the loop, finds the rows a killed process left `running`.
//     One with attempts left goes back to `pending`; one without is `failed`
//     and its settled listeners run, so the slice marks its subject failed
//     instead of showing it as working forever.
//   - CONCURRENCY ONE: the runner claims and runs one job at a time, AI or not
//     (a laptop, one PGlite session, the user's own provider limits).
//
// A rate-limited attempt (`KvoxRateLimitError`) still defers without spending
// an attempt, and dedup is still `jobs_active_dedup_uniq_idx`.
// =============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RATE_LIMIT_MS = 5000;
/** The runtime limit of a handler whose profile names none. */
export const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
/** What a recovered row records as its last error. */
export const INTERRUPTED_ERROR = 'Interrupted: KVox stopped while this job was running';

/** The error an attempt fails with when it outlives its `maxRuntimeMs`. */
export class KvoxJobTimeoutError extends Error {
  constructor(type: string, maxRuntimeMs: number) {
    super(`Job ${type} ran longer than its limit of ${maxRuntimeMs} ms`);
    this.name = 'KvoxJobTimeoutError';
  }
}

/** Options of {@link PgTableJobs}. */
export interface PgTableJobsOptions {
  /** The folder whose `tmp/` holds the scratch files `tempPath` hands out (emptied at start-up). */
  dataDir: string;
  /** The organization stamped on every job (`jobs.org_id`; `null` for none). */
  orgId?: string | null;
  /** The first retry's delay; it doubles per attempt. Default 5 s. */
  backoffBaseMs?: number;
  /** The longest retry delay. Default 5 min. */
  backoffMaxMs?: number;
  /** Receives one line per recovered row and per timeout (ids and types only). */
  log?: (line: string) => void;
}

/** What {@link PgTableJobs.describeJob} answers. */
export interface JobDescription {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  lastError: string | null;
}

/** Options of {@link PgTableJobs.drain}. */
export interface DrainOptions {
  /** Keep claiming until nothing is runnable (default true); false runs at most `maxJobs` (default 1). */
  untilIdle?: boolean;
  /** The most jobs to run in this call (default 1000 when `untilIdle`, else 1). */
  maxJobs?: number;
  /**
   * Treat `scheduled_for` as already due. A test uses it to fast-forward the poll
   * back-off of `transcription.poll` instead of sleeping.
   */
  ignoreSchedule?: boolean;
}

interface ClaimedRow {
  id: string;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  org_id: string | null;
}

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/** The dedup key of an enqueue, as the platform's `buildDedupKey` spells it. */
function dedupKeyOf(input: KvoxEnqueueInput): string | null {
  if (input.skipDedup) return null;
  return `${input.type}:${input.subjectType ?? ''}:${input.subjectId ?? ''}`;
}

/**
 * KVOX_JOBS over the platform `jobs` table, run in this process.
 *
 * @example
 * ```ts
 * const jobs = new PgTableJobs(prisma, { dataDir: '.data', orgId });
 * jobs.start();                     // a 200 ms background loop
 * await jobs.drain();               // or run everything that is due, now
 * ```
 */
export class PgTableJobs implements KvoxJobsPort {
  private readonly logger = new Logger('PgTableJobs');
  private readonly handlers = new Map<string, KvoxJobHandler>();
  private readonly listeners: Array<(event: KvoxJobSettledEvent) => void> = [];
  private readonly orgId: string | null;
  private readonly tempDir: string;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  /** Drains run one after another: the background loop and a test never claim at the same time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    options: PgTableJobsOptions,
  ) {
    this.orgId = options.orgId ?? null;
    this.tempDir = resolve(options.dataDir, 'tmp');
    this.backoffBaseMs = options.backoffBaseMs ?? 5000;
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60 * 1000;
    this.log = options.log ?? ((line) => this.logger.log(line));
    // This process's scratch space: whatever an earlier process left is garbage.
    rmSync(this.tempDir, { recursive: true, force: true });
    mkdirSync(this.tempDir, { recursive: true });
  }

  // -- enqueue ------------------------------------------------------------------

  enqueue(input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> {
    return this.insert(this.prisma, input);
  }

  /** The caller's open transaction owns the insert: the job exists for the runner once that transaction commits. */
  enqueueWithin(tx: unknown, input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> {
    return this.insert(tx as Db, input);
  }

  private async insert(db: Db, input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> {
    const dedupKey = dedupKeyOf(input);
    const id = randomUUID();
    const inserted = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO jobs (id, type, subject_type, subject_id, dedup_key, status, reason, priority, payload,
                        scheduled_for, provider_key, org_id)
      VALUES (${id}::uuid, ${input.type}, ${input.subjectType ?? null}, ${input.subjectId ?? null}, ${dedupKey},
              'pending'::"JobStatus", ${input.reason ?? 'enqueue'}, ${input.priority ?? 0},
              ${JSON.stringify(input.payload)}::jsonb, ${input.scheduledFor ?? null}::timestamptz,
              ${input.throttleKey ?? null}, ${this.orgId}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id`);
    if (inserted.length > 0) return { id: inserted[0].id, deduplicated: false };

    // The partial unique index refused it: a pending or running job has this key.
    if (dedupKey === null) throw new Error(`The jobs table refused a job of type ${input.type} that opted out of dedup`);
    const existing = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id::text AS id FROM jobs
       WHERE dedup_key = ${dedupKey} AND status IN ('pending'::"JobStatus", 'running'::"JobStatus")
       LIMIT 1`);
    if (existing.length > 0) return { id: existing[0].id, deduplicated: true };
    // It settled between the two statements: the key is free again.
    return this.insert(db, input);
  }

  // -- registration and listeners -----------------------------------------------

  registerHandler(handler: KvoxJobHandler): void {
    if (this.handlers.has(handler.type)) throw new Error(`A handler for job type "${handler.type}" is already registered`);
    // The same rule as the web edition: an AI job spends the user's own key and never runs on a node.
    if (handler.usesAi && handler.nodeResultSchema) {
      throw new Error(`Job type "${handler.type}" calls a model and also declares a node result; AI handlers stay on the server`);
    }
    this.handlers.set(handler.type, handler);
  }

  isRegistered(type: string): boolean {
    return this.handlers.has(type);
  }

  onSettled(listener: (event: KvoxJobSettledEvent) => void): void {
    this.listeners.push(listener);
  }

  // -- queries ------------------------------------------------------------------

  async findActive(query: KvoxActiveJobQuery): Promise<KvoxActiveJob[]> {
    if (query.types.length === 0) return [];
    const matches: Prisma.Sql[] = [];
    if (query.subjectIds !== undefined) {
      matches.push(
        query.subjectIds.length === 0 || query.subjectType === undefined
          ? Prisma.sql`FALSE`
          : Prisma.sql`(subject_type = ${query.subjectType} AND subject_id IN (${Prisma.join([...query.subjectIds])}))`,
      );
    }
    if (query.payloadValues !== undefined) {
      matches.push(
        query.payloadValues.length === 0 || query.payloadKey === undefined
          ? Prisma.sql`FALSE`
          : Prisma.sql`(payload ->> ${query.payloadKey} IN (${Prisma.join([...query.payloadValues])}))`,
      );
    }
    const scope = matches.length === 0 ? Prisma.empty : Prisma.sql`AND (${Prisma.join(matches, ' OR ')})`;
    const exclude = query.excludeJobId === undefined ? Prisma.empty : Prisma.sql`AND id <> ${query.excludeJobId}::uuid`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; type: string; subject_type: string | null; subject_id: string | null; payload: unknown }>>(
      Prisma.sql`
        SELECT id::text AS id, type, subject_type, subject_id, payload FROM jobs
         WHERE status IN ('pending'::"JobStatus", 'running'::"JobStatus")
           AND type IN (${Prisma.join([...query.types])})
           ${exclude} ${scope}
         ORDER BY created_at`,
    );
    return rows.map((row) => ({ id: row.id, type: row.type, subjectType: row.subject_type, subjectId: row.subject_id, payload: row.payload ?? {} }));
  }

  async findLatest(query: { type: string; subjectType: string; subjectId?: string }): Promise<KvoxJobSnapshot | null> {
    const subject = query.subjectId === undefined ? Prisma.empty : Prisma.sql`AND subject_id = ${query.subjectId}`;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; status: KvoxJobSnapshot['status']; scheduled_for: Date | null; created_at: Date; finished_at: Date | null }>
    >(Prisma.sql`
      SELECT id::text AS id, type, status::text AS status, scheduled_for, created_at, finished_at FROM jobs
       WHERE type = ${query.type} AND subject_type = ${query.subjectType} ${subject}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`);
    const row = rows[0];
    return row
      ? { id: row.id, type: row.type, status: row.status, scheduledFor: row.scheduled_for, createdAt: row.created_at, finishedAt: row.finished_at }
      : null;
  }

  async runNow(jobId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE jobs SET scheduled_for = NULL
       WHERE id = ${jobId}::uuid AND status = 'pending'::"JobStatus" AND scheduled_for > now()
      RETURNING id::text AS id`);
    return rows.length > 0;
  }

  tempPath(suffix = ''): string {
    return join(this.tempDir, `${randomUUID()}${suffix}`);
  }

  /** One job's state and last error, for the host's own routes (the backup card). */
  async describeJob(jobId: string): Promise<JobDescription | null> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; status: JobDescription['status']; attempts: number; last_error: string | null }>
    >(Prisma.sql`SELECT id::text AS id, type, status::text AS status, attempts, last_error FROM jobs WHERE id = ${jobId}::uuid`);
    const row = rows[0];
    return row ? { id: row.id, type: row.type, status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
  }

  // -- crash recovery -------------------------------------------------------------

  /**
   * Settles the rows an earlier process left `running` (it was killed, or the
   * machine lost power). Call it once, after every handler is registered and
   * before {@link start}: nothing of this process is running yet, so every
   * `running` row is an orphan.
   *
   * @returns how many rows went back to `pending` and how many failed.
   */
  async recoverInterrupted(): Promise<{ requeued: number; failed: number }> {
    const orphans = await this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      SELECT id::text AS id, type, subject_type, subject_id, payload, attempts, org_id::text AS org_id
        FROM jobs WHERE status = 'running'::"JobStatus" ORDER BY created_at`);
    let requeued = 0;
    let failed = 0;
    for (const row of orphans) {
      const maxAttempts = this.handlers.get(row.type)?.profile?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (row.attempts < maxAttempts) {
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE jobs SET status = 'pending'::"JobStatus", started_at = NULL, scheduled_for = NULL, last_error = ${INTERRUPTED_ERROR}
           WHERE id = ${row.id}::uuid AND status = 'running'::"JobStatus"`);
        requeued += 1;
      } else {
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE jobs SET status = 'failed'::"JobStatus", finished_at = now(), last_error = ${INTERRUPTED_ERROR}
           WHERE id = ${row.id}::uuid AND status = 'running'::"JobStatus"`);
        this.settle(row, 'failed', INTERRUPTED_ERROR);
        failed += 1;
      }
      this.log(`jobs: recovered interrupted job ${row.id} (${row.type}, attempt ${row.attempts} of ${maxAttempts})`);
    }
    return { requeued, failed };
  }

  // -- running ------------------------------------------------------------------

  /** Starts the background loop: a drain every `intervalMs`. */
  start(intervalMs = 200): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain({ untilIdle: false, maxJobs: 10 }).catch((error: unknown) =>
        this.logger.error(`The job loop failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, intervalMs);
    this.timer.unref();
  }

  /** Stops the background loop and waits for the drain in flight. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.chain.catch(() => undefined);
  }

  /**
   * Claims and runs due jobs of registered types, one at a time.
   *
   * @returns how many attempts ran.
   */
  drain(options: DrainOptions = {}): Promise<number> {
    const run = this.chain.then(() => this.drainNow(options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async drainNow(options: DrainOptions): Promise<number> {
    const untilIdle = options.untilIdle ?? true;
    const maxJobs = options.maxJobs ?? (untilIdle ? 1000 : 1);
    let ran = 0;
    while (ran < maxJobs) {
      const claimed = await this.claim(options.ignoreSchedule === true);
      if (!claimed) break;
      ran += 1;
      await this.run(claimed);
    }
    return ran;
  }

  private async claim(ignoreSchedule: boolean): Promise<ClaimedRow | null> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) return null;
    const due = ignoreSchedule ? Prisma.empty : Prisma.sql`AND (scheduled_for IS NULL OR scheduled_for <= now())`;
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE jobs
         SET status = 'running'::"JobStatus", attempts = attempts + 1, started_at = now(), executor = 'server'
       WHERE id = (SELECT id FROM jobs
                    WHERE status = 'pending'::"JobStatus" AND type IN (${Prisma.join(types)}) ${due}
                    ORDER BY priority ASC, created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
      RETURNING id::text AS id, type, subject_type, subject_id, payload, attempts, org_id::text AS org_id`);
    return rows[0] ?? null;
  }

  private async run(row: ClaimedRow): Promise<void> {
    const handler = this.handlers.get(row.type) as KvoxJobHandler;
    const job: KvoxJob = {
      id: row.id,
      type: row.type,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      payload: row.payload ?? {},
      attempts: row.attempts,
      orgId: row.org_id,
    };

    const maxRuntimeMs = handler.profile?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new KvoxJobTimeoutError(row.type, maxRuntimeMs);
        controller.abort(error);
        this.log(`jobs: job ${row.id} (${row.type}) timed out after ${maxRuntimeMs} ms`);
        reject(error);
      }, maxRuntimeMs);
    });
    // `signal` is not part of KvoxJob: an extra a handler may read, ignored by the rest.
    const attempt = handler.process(Object.assign(job, { signal: controller.signal }));
    // The outcome of an attempt that timed out is discarded, its rejection included.
    attempt.catch(() => undefined);
    try {
      await Promise.race([attempt, timeout]);
    } catch (error) {
      await this.failed(row, handler, error);
      return;
    } finally {
      clearTimeout(timer);
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE jobs SET status = 'succeeded'::"JobStatus", finished_at = now(), last_error = NULL
       WHERE id = ${row.id}::uuid`);
    this.settle(row, 'succeeded', null);
  }

  private async failed(row: ClaimedRow, handler: KvoxJobHandler, error: unknown): Promise<void> {
    if (error instanceof KvoxRateLimitError) {
      // Not the job's fault: it does not spend an attempt, it waits for the provider.
      const waitMs = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE jobs SET status = 'pending'::"JobStatus", attempts = attempts - 1,
               scheduled_for = now() + (${waitMs} * interval '1 millisecond'),
               rate_limited_at = now(), rate_limit_hits = rate_limit_hits + 1, provider_key = ${error.throttleKey}
         WHERE id = ${row.id}::uuid`);
      return;
    }

    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const terminal = row.attempts >= (handler.profile?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    if (!terminal) {
      const delayMs = Math.min(this.backoffBaseMs * 2 ** Math.max(row.attempts - 1, 0), this.backoffMaxMs);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE jobs SET status = 'pending'::"JobStatus", last_error = ${message},
               scheduled_for = now() + (${delayMs} * interval '1 millisecond')
         WHERE id = ${row.id}::uuid`);
      return;
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE jobs SET status = 'failed'::"JobStatus", finished_at = now(), last_error = ${message} WHERE id = ${row.id}::uuid`);
    this.settle(row, 'failed', message);
  }

  /** Listeners are bystanders: after the status write, and a throw goes to the log. */
  private settle(row: ClaimedRow, status: 'succeeded' | 'failed', lastError: string | null): void {
    const event: KvoxJobSettledEvent = {
      jobId: row.id,
      type: row.type,
      status,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      payload: row.payload ?? {},
      lastError,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(`A job listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
