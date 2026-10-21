import type { INestApplicationContext } from '@nestjs/common';

import { SearchIndexStatusService } from '@marinoscar/kvox-api/search';

// =============================================================================
// Indexing the library for on-device semantic search (marinoscar/kvox#660)
// =============================================================================
//
// The search slice owns indexing: `SearchIndexStatusService.requestIndex` queues
// the `search.index` jobs of every document that needs one (a document with no
// embeddings under the CURRENT model id, so a library indexed by OpenAI is queued
// again for the local model) and caps what one call queues. This file only asks.
// It reimplements nothing.
//
// WHEN IT ASKS, and only while on-device search is active:
//   - when the model becomes ready with the feature on, at start-up with both,
//     and when the user switches the feature on;
//   - on the hourly housekeeping tick, for the library that grew since.
//
// WHY A TIMER IS RIGHT HERE. The package has no search cron because indexing spends
// the user's own vendor account (`job-types.ts` of the search slice: no silent
// backfill). On-device embedding costs nothing and sends nothing anywhere, so the
// cost argument does not apply to it. Repeats are harmless: a document already queued
// is not a candidate, and the jobs table's dedup key refuses a second job for it.
//
// One call is capped, so a request that queued something is repeated until nothing
// remains (at most MAX_ROUNDS per run; the next tick continues).
// =============================================================================

/** Calls of `requestIndex` per run. */
export const BACKFILL_MAX_ROUNDS = 20;

/** Options of {@link createSearchBackfill}. */
export interface SearchBackfillOptions {
  /** The application (it does not exist yet while the AI binding starts: the run is then skipped). */
  app: () => INestApplicationContext | undefined;
  /** The one local user. */
  userId: string;
  /** Whether on-device search is switched on and the model installed. */
  active: () => Promise<boolean>;
  log: (line: string) => void;
}

/** The backfill: `run()` is single-flight and never throws. */
export interface SearchBackfill {
  run(): Promise<void>;
}

/** Builds the backfill. */
export function createSearchBackfill(options: SearchBackfillOptions): SearchBackfill {
  let running: Promise<void> | null = null;

  const once = async (): Promise<void> => {
    const app = options.app();
    if (!app || !(await options.active())) return;
    const service = app.get(SearchIndexStatusService, { strict: false });
    let total = 0;
    for (let round = 0; round < BACKFILL_MAX_ROUNDS; round += 1) {
      const result = await service.requestIndex(options.userId);
      total += result.queued;
      if (result.queued === 0 || result.remaining === 0) break;
    }
    if (total > 0) options.log(`local search: queued ${total} document(s) for indexing`);
  };

  return {
    run() {
      running ??= once()
        .catch((error: unknown) => options.log(`local search: indexing was not requested: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
