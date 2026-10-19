import { randomUUID } from 'node:crypto';

import type { CopilotProviderAdapter, CopilotTransport, PreparedCopilotRuntime } from '@marinoscar/kvox-ai/copilot';
import { AI_KEYLESS_API_KEY } from '@marinoscar/platform-ai-providers';

import { CopilotDownloadUnavailableError, type CopilotHost } from './copilot-host.js';
import type { CopilotSignInChallenge, CopilotStatus } from './copilot-contract.js';

// =============================================================================
// The Copilot lifecycle of KVox Desktop (marinoscar/kvox-desktop#21)
// =============================================================================
//
// Owns the ADAPTER (built only while Copilot is on and consented), its transport,
// the runtime state, the sign-in flow and the model list. It holds no Copilot
// mechanics: every one of them is `@marinoscar/kvox-ai/copilot` (the adapter, the
// sign-in flow, `prepareCopilotRuntime`, the SDK transport), reached through the
// {@link CopilotHost} seam.
//
// LOADED ONLY WHEN ON. The package entry (and through it the SDK, which the
// transport requires lazily) is `import()`ed the first time Copilot is switched
// on; with Copilot off nothing here runs, so start-up costs the same as before.
//
// ⚠ NO TOKEN CROSSES THIS FILE. The Copilot runtime keeps the GitHub sign-in; we
// see only "signed in as <login>" and a challenge (an address, or a code).
// Anything logged goes through `redactTokens`.
// =============================================================================

/** A model the Copilot add-on can run a task on. */
export interface CopilotModelRow {
  id: string;
  label: string;
  structuredOutput: 'native' | 'prompted';
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** How long a sign-in answer is trusted before the runtime is asked again. */
const AUTH_TTL_MS = 10_000;

type RuntimeStatus = CopilotStatus['runtime'];

/** Raised for the 409s of the Copilot endpoints. */
export class CopilotConflictError extends Error {
  constructor(
    readonly code: 'runtime_not_ready' | 'runtime_download_unavailable' | 'copilot_disabled' | 'sign_in_not_started',
    message: string,
  ) {
    super(message);
    this.name = 'CopilotConflictError';
  }
}

/** Options of {@link CopilotService}. */
export interface CopilotServiceOptions {
  host: CopilotHost;
  /** One line per event; never carries a prompt, an answer or a token. */
  log: (line: string) => void;
}

type CopilotModule = typeof import('@marinoscar/kvox-ai/copilot');

/** The Copilot adapter, runtime and sign-in for one Desktop server. */
export class CopilotService {
  private module: CopilotModule | undefined;
  private adapter: CopilotProviderAdapter | null = null;
  private transport: CopilotTransport | null = null;
  private runtime: RuntimeStatus = { state: 'missing', version: null, progress: null };
  private starting: Promise<void> | null = null;
  private download: AbortController | null = null;
  private flow: AbortController | null = null;
  private auth: { signedIn: boolean; login: string | null; at: number } | null = null;
  private liveModels: CopilotModelRow[] | null = null;
  /** Bumped by every deactivate, so a start that was overtaken drops what it built. */
  private generation = 0;

  constructor(private readonly options: CopilotServiceOptions) {}

  // ---- Lifecycle ----------------------------------------------------------------

  /** True while the adapter exists (Copilot is on and its runtime is ready). */
  get ready(): boolean {
    return this.adapter !== null;
  }

  /** The adapter, for the runtime's provider map; `null` while there is none. */
  get providerAdapter(): CopilotProviderAdapter | null {
    return this.adapter;
  }

  /**
   * Brings the adapter up (Copilot is on). Never throws: a runtime that is missing or broken
   * is a runtime STATE the status reports, not a failure of whatever switched Copilot on.
   */
  async activate(): Promise<void> {
    if (this.adapter) return;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  /** Takes the adapter down (Copilot is off): cancels a sign-in or download and stops the runtime. */
  async deactivate(): Promise<void> {
    this.generation += 1;
    this.flow?.abort();
    this.flow = null;
    this.download?.abort();
    this.download = null;
    const transport = this.transport;
    this.adapter = null;
    this.transport = null;
    this.auth = null;
    this.liveModels = null;
    if (this.runtime.state === 'downloading') this.runtime = { state: 'missing', version: null, progress: null };
    await transport?.stop?.().catch(() => undefined);
  }

  /** Server shutdown. */
  async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.deactivate();
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    try {
      const prepared = await this.options.host.prepareRuntime({ dataDirectory: this.options.host.dataDirectory, download: false });
      await this.build(prepared, generation);
    } catch (error) {
      this.runtimeFailed(error, generation);
    }
  }

  /** Builds the transport and the adapter over a prepared runtime. */
  private async build(prepared: PreparedCopilotRuntime, generation: number): Promise<void> {
    const copilot = await this.load();
    const transport = await this.options.host.createTransport(prepared);
    if (generation !== this.generation) {
      await transport.stop?.().catch(() => undefined);
      return;
    }
    this.transport = transport;
    this.adapter = copilot.createCopilotAdapter({
      optIn: true,
      transport,
      logger: {
        info: (entry) => this.options.log(`copilot: ${copilot.redactTokens(JSON.stringify(entry))}`),
        warn: (entry) => this.options.log(`copilot: warn ${copilot.redactTokens(JSON.stringify(entry))}`),
      },
    });
    this.runtime = { state: 'ready', version: prepared.version, progress: null };
    this.options.log(`copilot: runtime ${prepared.version} ready (${prepared.source})`);
  }

  private runtimeFailed(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    const check = errorCheck(error);
    this.runtime = { state: check === 'runtime_missing' ? 'missing' : 'error', version: null, progress: null };
    // The message is the package's (redacted) or ours; never a token.
    this.options.log(`copilot: runtime ${this.runtime.state}${check ? ` (${check})` : ''}`);
  }

  private async load(): Promise<CopilotModule> {
    this.module ??= await import('@marinoscar/kvox-ai/copilot');
    return this.module;
  }

  // ---- Runtime download ---------------------------------------------------------

  /** The runtime state the status reports. */
  runtimeStatus(): RuntimeStatus {
    return { ...this.runtime };
  }

  /**
   * Starts the opt-in runtime download and returns at once; progress shows in the status.
   * Single-flight. A runtime that is already ready is left as it is.
   */
  startDownload(): void {
    if (this.adapter || this.download) return;
    if (!this.options.host.canDownload) {
      throw new CopilotConflictError('runtime_download_unavailable', 'This build of KVox has no GitHub Copilot runtime download. Install a build that includes the runtime.');
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.download = controller;
    this.runtime = { state: 'downloading', version: null, progress: 0 };
    void this.runDownload(controller, generation);
  }

  /** Cancels a running download. */
  cancelDownload(): void {
    this.download?.abort();
  }

  private async runDownload(controller: AbortController, generation: number): Promise<void> {
    try {
      const prepared = await this.options.host.prepareRuntime({
        dataDirectory: this.options.host.dataDirectory,
        download: true,
        signal: controller.signal,
        onProgress: ({ received, total }) => {
          if (generation !== this.generation || this.runtime.state !== 'downloading') return;
          this.runtime = { state: 'downloading', version: null, progress: total && total > 0 ? Math.min(1, received / total) : this.runtime.progress };
        },
      });
      if (controller.signal.aborted || generation !== this.generation) throw new Error('cancelled');
      await this.build(prepared, generation);
    } catch (error) {
      if (generation === this.generation) {
        if (controller.signal.aborted) this.runtime = { state: 'missing', version: null, progress: null };
        else if (error instanceof CopilotDownloadUnavailableError) this.runtime = { state: 'missing', version: null, progress: null };
        else this.runtimeFailed(error, generation);
      }
    } finally {
      if (this.download === controller) this.download = null;
    }
  }

  // ---- Sign-in ------------------------------------------------------------------

  private requireAdapter(): CopilotProviderAdapter {
    if (!this.adapter) {
      throw new CopilotConflictError('runtime_not_ready', 'The GitHub Copilot runtime is not ready. Download it first, or restart KVox after it is installed.');
    }
    return this.adapter;
  }

  /** Begins a sign-in; the challenge is an address to open or a code to type, never a token. */
  async signInStart(): Promise<CopilotSignInChallenge> {
    const adapter = this.requireAdapter();
    this.flow?.abort();
    this.flow = new AbortController();
    return (await adapter.signIn.start()) as CopilotSignInChallenge;
  }

  /** Resolves once the user has signed in; `signal` aborts it (a client that went away). */
  async signInWait(signal?: AbortSignal): Promise<void> {
    const adapter = this.requireAdapter();
    const flow = this.flow;
    if (!flow) throw new CopilotConflictError('sign_in_not_started', 'No GitHub sign-in is in progress. Start one first.');
    const onAbort = () => flow.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await adapter.signIn.wait(flow.signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.flow === flow) this.flow = null;
    }
    this.auth = null;
    this.liveModels = null;
    await this.refreshAuth();
    await this.models();
  }

  async signOut(): Promise<void> {
    const adapter = this.requireAdapter();
    this.flow?.abort();
    this.flow = null;
    await adapter.signOut();
    this.auth = null;
    this.liveModels = null;
    await this.refreshAuth();
  }

  // ---- Sign-in state and models -------------------------------------------------

  /** Who is signed in. Cached for a few seconds; a failure reads as signed out. */
  async authStatus(): Promise<{ signedIn: boolean; login: string | null }> {
    if (!this.adapter) return { signedIn: false, login: null };
    if (this.auth && Date.now() - this.auth.at < AUTH_TTL_MS) return this.auth;
    return this.refreshAuth();
  }

  private async refreshAuth(): Promise<{ signedIn: boolean; login: string | null }> {
    const adapter = this.adapter;
    if (!adapter) return { signedIn: false, login: null };
    try {
      const state = await adapter.authStatus();
      this.auth = { signedIn: state.signedIn, login: state.login, at: Date.now() };
    } catch (error) {
      this.options.log(`copilot: could not read the sign-in state (${errorCheck(error) ?? 'error'})`);
      this.auth = { signedIn: false, login: null, at: Date.now() };
    }
    return this.auth;
  }

  /** The models to offer: the signed-in user's live listing, else the package's fallback catalog. */
  async models(): Promise<CopilotModelRow[]> {
    const adapter = this.adapter;
    if (!adapter) return [];
    const copilot = await this.load();
    const fallback = copilot.COPILOT_CATALOG.map(
      (entry): CopilotModelRow => ({
        id: entry.id,
        label: entry.label,
        structuredOutput: entry.structuredOutputMode,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
      }),
    );
    const auth = await this.authStatus();
    if (!auth.signedIn) return fallback;
    if (this.liveModels) return this.liveModels;
    try {
      const listed = await adapter.listModels?.({ apiKey: AI_KEYLESS_API_KEY, requestId: randomUUID() });
      if (listed && listed.length > 0) {
        this.liveModels = listed.map((model) => {
          const known = adapter.kvox.catalog.lookup('copilot', model.id);
          return {
            id: model.id,
            label: model.metadata?.displayName ?? model.id,
            structuredOutput: known?.structuredOutputMode ?? 'prompted',
            contextWindow: model.metadata?.inputTokenLimit ?? known?.contextWindow ?? null,
            maxOutputTokens: model.metadata?.outputTokenLimit ?? known?.maxOutputTokens ?? null,
          };
        });
        return this.liveModels;
      }
    } catch (error) {
      this.options.log(`copilot: could not list the models (${errorCheck(error) ?? 'error'}); using the fallback list`);
    }
    return fallback;
  }

  /** The model a task runs on: the user's pick when it is offered, else the first offered. */
  async pickModel(preferred: string | null): Promise<string | null> {
    const models = await this.models();
    if (preferred && models.some((model) => model.id === preferred)) return preferred;
    return models[0]?.id ?? null;
  }

  /** What `createDirectRuntime`'s key source answers for the Copilot provider. */
  async keyAvailable(): Promise<boolean> {
    return this.adapter !== null && (await this.authStatus()).signedIn;
  }

  /** The part of the status this service knows (the routing's unavailable tasks and `enabled` are the caller's). */
  async statusSnapshot(): Promise<Omit<CopilotStatus, 'enabled' | 'unavailableTasks'>> {
    const auth = await this.authStatus();
    const models = await this.models();
    return {
      signedIn: auth.signedIn,
      login: auth.login,
      runtime: this.runtimeStatus(),
      models: models.map((model) => ({ id: model.id, label: model.label, structuredOutput: model.structuredOutput })),
    };
  }
}

/** The `details.check` of a package error, else a thrown error's code, else `null` (never a message). */
function errorCheck(error: unknown): string | null {
  const details = (error as { details?: { check?: unknown } } | null)?.details;
  if (details && typeof details.check === 'string') return details.check;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}
