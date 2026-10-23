// =============================================================================
// One library sync at a time (marinoscar/kvox-desktop#47)
// =============================================================================
//
// The controller's scheduling, apart from React: syncs run one after the
// other (the local server has one database writer, and the main process reads
// the files), a library is queued at most once, and a request for the library
// that is syncing right now runs it once more afterwards (a change seen during
// a sync is not lost). What a sync does is kvox-web's `runLibrarySync`.
// =============================================================================

/** A serial queue of keys. */
export interface SerialQueue {
  /** Queues `key` (no-op when already queued; re-runs it once when it is running). */
  enqueue(key: string): void;
  /** Drops what is queued and refuses new keys; the running one finishes. */
  close(): void;
  /** Resolves when nothing is running or queued (for tests). */
  idle(): Promise<void>;
}

/** Creates a {@link SerialQueue} that runs `run(key)` for each key, one at a time. A rejection is swallowed. */
export function createSerialQueue(run: (key: string) => Promise<void>): SerialQueue {
  const pending: string[] = [];
  const rerun = new Set<string>();
  let running: string | null = null;
  let closed = false;
  let waiters: Array<() => void> = [];

  const settle = () => {
    if (running !== null || pending.length > 0) return;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  const pump = (): void => {
    if (running !== null) return;
    const key = pending.shift();
    if (key === undefined) {
      settle();
      return;
    }
    running = key;
    void run(key)
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (rerun.delete(key) && !closed && !pending.includes(key)) pending.push(key);
        pump();
      });
  };

  return {
    enqueue(key) {
      if (closed) return;
      if (running === key) rerun.add(key);
      else if (!pending.includes(key)) pending.push(key);
      pump();
    },
    close() {
      closed = true;
      pending.length = 0;
      rerun.clear();
      settle();
    },
    idle() {
      if (running === null && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
