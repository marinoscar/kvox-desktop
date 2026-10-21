import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// One KVOX_AI over two providers' ports (marinoscar/kvox-desktop#21)
// =============================================================================
//
// `createKvoxAi` serves ONE provider per task-model state, so two providers at
// once (Copilot for what it can serve, the primary provider for the rest) are two
// ports behind this thin delegating one. It decides nothing about AI: the caller's
// `serving` says which provider answers a task (`routeKvoxTasks` of
// `@marinoscar/kvox-ai`), and a call that already carries a target goes to the
// provider that target names. Every mechanic (structured output, retries, errors)
// stays in the two `createKvoxAi` ports.
// =============================================================================

/** The two providers a call can be routed to (the on-device embedding model is a third port, below). */
export type RoutedProvider = 'primary' | 'copilot';

/** The feature whose capabilities and embeddings the on-device model serves (the search slice's). */
export const LOCAL_EMBEDDING_FEATURE = 'search.embed';

/** Options of {@link createRoutedKvoxAi}. */
export interface RoutedKvoxAiOptions {
  /** The port over the primary provider (OpenAI, an OpenAI-compatible server, or none). */
  primary: KvoxAiPort;
  /** The port over GitHub Copilot. */
  copilot: KvoxAiPort;
  /** Which provider serves a task right now (a registered feature id such as `notes.generate`). */
  serving(task: string): Promise<RoutedProvider>;
  /** The id of the Copilot provider as a target names it. */
  copilotProviderId: string;
  /**
   * The on-device embedding port (marinoscar/kvox#660) and whether it serves now (the user switched
   * local search on AND the model is installed). Absent, or false: behaviour is exactly as without it.
   */
  local?: { port: KvoxAiPort; active(): boolean | Promise<boolean> };
}

/** A KVOX_AI port that sends each call to the provider that serves it. */
export function createRoutedKvoxAi(options: RoutedKvoxAiOptions): KvoxAiPort {
  const { primary, copilot } = options;
  const byTarget = (provider: string): KvoxAiPort => (provider === options.copilotProviderId ? copilot : primary);
  const forTask = async (task: string): Promise<KvoxAiPort> => ((await options.serving(task)) === 'copilot' ? copilot : primary);

  // Only `search.embed` goes to the on-device model. `graph.embed` keeps today's routing on purpose:
  // the graph's similarity thresholds are tuned to OpenAI's vectors, not to this model's.
  const localFor = async (feature: string): Promise<KvoxAiPort | null> =>
    options.local && feature === LOCAL_EMBEDDING_FEATURE && (await options.local.active()) ? options.local.port : null;

  return {
    async capabilities(ctx) {
      const local = await localFor(ctx.feature);
      return local ? local.capabilities(ctx) : (await forTask(ctx.feature)).capabilities(ctx);
    },
    async resolveTask(ctx, task, opts) {
      return (await forTask(task)).resolveTask(ctx, task, opts);
    },
    generateText: (ctx, req) => byTarget(req.target.provider).generateText(ctx, req),
    generateStructured: (ctx, req) => byTarget(req.target.provider).generateStructured(ctx, req),
    chat: (ctx, req) => byTarget(req.target.provider).chat(ctx, req),
    // Copilot has no embeddings: they go to the primary provider, except the search's while local search serves.
    embed: async (ctx, req) => {
      const local = await localFor(ctx.feature);
      return (local ?? primary).embed(ctx, req);
    },
    countTokens: (target, text) => byTarget(target.provider).countTokens(target, text),
  };
}
