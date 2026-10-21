import {
  LOCAL_EMBEDDING_MANIFEST,
  LocalEmbeddingDownloadError,
  downloadLocalEmbeddingModel,
  localEmbeddingModelStatus,
  removeLocalEmbeddingModel,
  type DownloadLocalEmbeddingModelOptions,
  type LocalEmbeddingInstall,
  type LocalEmbeddingModelStatus,
} from '@marinoscar/kvox-ai/local-embeddings';

// =============================================================================
// The on-device embedding model's lifecycle (marinoscar/kvox#660)
// =============================================================================
//
// Owns ONE thing: whether the model files are on this machine, and the opt-in,
// cancellable, single-flight download that puts them there. It holds no model
// mechanics (the download, its SHA-256 pinning, the host allowlist per hop and
// the status check are `@marinoscar/kvox-ai/local-embeddings`) and decides
// nothing about settings or routing (`DesktopAi` does, with `localSearch`).
//
//   missing      nothing installed (or a download was cancelled)
//   downloading  `progress` 0..1 of the manifest's bytes
//   ready        installed; `modelPath` is the directory the embedder loads
//   error        the last download failed; `error` says why (no URL, no secret)
//
// Same shape as the Copilot runtime download (`copilot-service.ts`): an
// AbortController per download and a generation counter, so a download that was
// cancelled or overtaken by `remove()` can never publish a state afterwards.
// `onDownloadSettled` fires when the download stops running, however it ends:
// the caller drops the download hosts from the egress allowlist there.
// =============================================================================

/** The service's state. */
export type LocalEmbeddingsState = 'missing' | 'downloading' | 'ready' | 'error';

/** The package's download, status and removal, as one seam (a fake in the tests). */
export interface LocalEmbeddingsDownloader {
  download(options: DownloadLocalEmbeddingModelOptions): Promise<LocalEmbeddingInstall>;
  status(directory: string): Promise<LocalEmbeddingModelStatus>;
  remove(directory: string): Promise<void>;
}

/** The real thing: `@marinoscar/kvox-ai/local-embeddings`. */
export const packageDownloader: LocalEmbeddingsDownloader = {
  download: downloadLocalEmbeddingModel,
  status: localEmbeddingModelStatus,
  remove: removeLocalEmbeddingModel,
};

/** The sum of the manifest's file sizes: what the download costs. */
export const LOCAL_EMBEDDING_SIZE_BYTES: number = LOCAL_EMBEDDING_MANIFEST.files.reduce((sum, file) => sum + file.size, 0);

/** Options of {@link LocalEmbeddingsService}. */
export interface LocalEmbeddingsServiceOptions {
  /** `<userData>/models`. */
  directory: string;
  downloader?: LocalEmbeddingsDownloader;
  /** Called when a download stops running (installed, failed or cancelled). */
  onDownloadSettled?: (state: LocalEmbeddingsState) => void;
  /** One line per event; never a URL with a query. */
  log?: (line: string) => void;
}

/** What the status endpoint reports of the model. */
export interface LocalEmbeddingsSnapshot {
  state: LocalEmbeddingsState;
  /** 0..1 while downloading; 1 when ready; `null` otherwise. */
  progress: number | null;
  error: string | null;
}

/** The on-device model: derived from the files on start, then driven by download, cancel and remove. */
export class LocalEmbeddingsService {
  private current: LocalEmbeddingsState = 'missing';
  private fraction: number | null = null;
  private failure: string | null = null;
  private path: string | null = null;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  /** Bumped by every cancel and remove, so a download that was overtaken publishes nothing. */
  private generation = 0;

  constructor(private readonly options: LocalEmbeddingsServiceOptions) {}

  private get downloader(): LocalEmbeddingsDownloader {
    return this.options.downloader ?? packageDownloader;
  }

  /** Derives the state from the files (server start). Cheap: sizes and the install record, no hashing. */
  async init(): Promise<void> {
    const status = await this.downloader.status(this.options.directory).catch(() => ({ installed: false }) as LocalEmbeddingModelStatus);
    if (this.controller) return; // a download started meanwhile owns the state
    if (status.installed && status.path) this.markReady(status.path);
    else this.reset();
  }

  get state(): LocalEmbeddingsState {
    return this.current;
  }

  /** Whether the model is installed and the embedder can load it. */
  get ready(): boolean {
    return this.current === 'ready' && this.path !== null;
  }

  /** The installed model directory, or `null` while not ready. */
  get modelPath(): string | null {
    return this.current === 'ready' ? this.path : null;
  }

  /** Whether a download is running (the egress allowlist includes the download hosts meanwhile). */
  get downloading(): boolean {
    return this.controller !== null;
  }

  snapshot(): LocalEmbeddingsSnapshot {
    return { state: this.current, progress: this.fraction, error: this.failure };
  }

  /**
   * Starts the download. Single flight: while one runs, or when the model is installed,
   * it does nothing. Returns at once; progress shows in {@link snapshot}.
   */
  startDownload(): void {
    if ((this.controller && !this.controller.signal.aborted) || this.current === 'ready') return;
    const controller = new AbortController();
    const generation = this.generation;
    // A cancelled download may still be settling: the new one starts after it (one writer of the staging folder).
    const previous = this.running ?? Promise.resolve();
    this.controller = controller;
    this.current = 'downloading';
    this.fraction = 0;
    this.failure = null;
    const running: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.run(controller, generation))
      .finally(() => {
        if (this.running === running) this.running = null;
      });
    this.running = running;
  }

  /** Cancels a running download (the staged files are deleted by the package). */
  cancelDownload(): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.generation += 1;
    this.controller.abort();
    // The state is final NOW; the aborted download settles (and fires onDownloadSettled) a moment later.
    this.reset();
  }

  /** Cancels any download, deletes the installed model and reports it missing. */
  async remove(): Promise<void> {
    this.cancelDownload();
    this.generation += 1;
    await this.running?.catch(() => undefined);
    await this.downloader.remove(this.options.directory);
    this.reset();
  }

  /** Waits for a download in flight (tests, shutdown). */
  async settled(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Server shutdown: stops a download; the files stay. */
  async close(): Promise<void> {
    this.generation += 1;
    this.controller?.abort();
    await this.running?.catch(() => undefined);
  }

  private async run(controller: AbortController, generation: number): Promise<void> {
    try {
      const { path } = await this.downloader.download({
        directory: this.options.directory,
        signal: controller.signal,
        onProgress: (received, total) => {
          if (generation !== this.generation || this.current !== 'downloading') return;
          this.fraction = total > 0 ? Math.min(1, received / total) : this.fraction;
        },
      });
      if (generation !== this.generation || controller.signal.aborted) return;
      this.markReady(path);
      this.options.log?.('local search: the on-device model is installed');
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.current = 'error';
      this.fraction = null;
      this.failure = describe(error);
      this.options.log?.(`local search: the model download failed (${error instanceof LocalEmbeddingDownloadError ? error.code : 'error'})`);
    } finally {
      // Only the newest download clears the controller and tells the caller: an overtaken one must not
      // drop the download hosts from the allowlist under its successor.
      if (this.controller === controller) {
        this.controller = null;
        this.options.onDownloadSettled?.(this.current);
      }
    }
  }

  private markReady(path: string): void {
    this.current = 'ready';
    this.path = path;
    this.fraction = 1;
    this.failure = null;
  }

  private reset(): void {
    this.current = 'missing';
    this.path = null;
    this.fraction = null;
    this.failure = null;
  }
}

/** A readable, secret-free line for a failed download. */
function describe(error: unknown): string {
  if (error instanceof LocalEmbeddingDownloadError) return error.message;
  return error instanceof Error && error.message ? error.message : 'The model download failed.';
}
