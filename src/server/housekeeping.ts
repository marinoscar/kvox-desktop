import type { INestApplicationContext, Type } from '@nestjs/common';

import { KgMigrateEnqueuer } from '@marinoscar/kvox-api/graph';
import { KgExportExpiryEnqueuer } from '@marinoscar/kvox-api/graph-rdf';
import { NotesHousekeepingEnqueuer } from '@marinoscar/kvox-api/notes';
import { TranscriptsHousekeepingEnqueuer } from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// The housekeeping timer (what `@nestjs/schedule` would have done; marinoscar/kvox#586)
// =============================================================================
//
// From examples/bare-host/src/housekeeping.ts. Every slice is booted with
// `schedules: false`, so no cron is registered. Each slice still provides its
// enqueuer, and a cron only ever enqueues, so the host's whole duty is to call
// them on a timer:
//
//   TranscriptsHousekeepingEnqueuer   `transcripts.housekeeping`
//   NotesHousekeepingEnqueuer         `notes.housekeeping`
//   KgMigrateEnqueuer                 `kg.migrate`, one job per owner a declared
//                                     ontology migration touches (none declared: returns at once)
//   KgExportExpiryEnqueuer            the `kg.export` expiry sweep
//
// The enqueuers live in the slices' modules, so they are resolved with
// `strict: false`. The first tick runs shortly after start (a desktop app is
// rarely open for an hour), then hourly. `runOnce()` is what a test calls.
// =============================================================================

/** What one tick queued, per enqueuer (`null` when it had nothing to queue). */
export interface HousekeepingTick {
  transcripts: string | null;
  notes: string | null;
  kgMigrate: 'called';
  kgExportExpiry: 'called';
}

/** The housekeeping of the local server. */
export class Housekeeping {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  /**
   * @param app - the initialised application the enqueuers are resolved from.
   * @param options.intervalMs - the tick, default one hour.
   * @param options.firstTickMs - the delay of the first tick, default one minute.
   * @param options.log - receives a line per failed tick.
   */
  constructor(
    private readonly app: INestApplicationContext,
    private readonly options: { intervalMs?: number; firstTickMs?: number; log?: (line: string) => void } = {},
  ) {}

  /** Calls every enqueuer once, in order. Each only inserts job rows; the job loop runs them. */
  async runOnce(): Promise<HousekeepingTick> {
    const get = <T>(type: Type<T>): T => this.app.get(type, { strict: false });
    const transcripts = await get(TranscriptsHousekeepingEnqueuer).enqueue();
    const notes = await get(NotesHousekeepingEnqueuer).enqueue();
    await get(KgMigrateEnqueuer).enqueue();
    await get(KgExportExpiryEnqueuer).enqueue();
    return { transcripts, notes, kgMigrate: 'called', kgExportExpiry: 'called' };
  }

  /** Starts the timer. */
  start(): void {
    if (this.timer || this.first) return;
    this.first = setTimeout(() => {
      this.first = null;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 60 * 60 * 1000);
      this.timer.unref();
    }, this.options.firstTickMs ?? 60 * 1000);
    this.first.unref();
  }

  /** Stops the timer and waits for a tick in flight. */
  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.runOnce()
      .catch((error: unknown) => this.options.log?.(`housekeeping: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.running = null;
      });
  }
}
