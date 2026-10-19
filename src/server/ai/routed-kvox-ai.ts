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

/** The two providers a call can be routed to. */
export type RoutedProvider = 'primary' | 'copilot';

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
}

/** A KVOX_AI port that sends each call to the provider that serves it. */
export function createRoutedKvoxAi(options: RoutedKvoxAiOptions): KvoxAiPort {
  const { primary, copilot } = options;
  const byTarget = (provider: string): KvoxAiPort => (provider === options.copilotProviderId ? copilot : primary);
  const forTask = async (task: string): Promise<KvoxAiPort> => ((await options.serving(task)) === 'copilot' ? copilot : primary);

  return {
    async capabilities(ctx) {
      return (await forTask(ctx.feature)).capabilities(ctx);
    },
    async resolveTask(ctx, task, opts) {
      return (await forTask(task)).resolveTask(ctx, task, opts);
    },
    generateText: (ctx, req) => byTarget(req.target.provider).generateText(ctx, req),
    generateStructured: (ctx, req) => byTarget(req.target.provider).generateStructured(ctx, req),
    chat: (ctx, req) => byTarget(req.target.provider).chat(ctx, req),
    // Copilot has no embeddings: they always go to the primary provider.
    embed: (ctx, req) => primary.embed(ctx, req),
    countTokens: (target, text) => byTarget(target.provider).countTokens(target, text),
  };
}
