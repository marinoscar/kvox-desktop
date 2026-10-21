import type { EmbedderRequest, EmbedderResponse } from '../shared/protocol';

// =============================================================================
// The embedder utility process's logic (marinoscar/kvox#660)
// =============================================================================
//
// `embedder.ts` wires this to `process.parentPort`; the logic is here so a test
// can drive it with a fake model. It answers each request with exactly one
// response, in order, one batch at a time (the model blocks the event loop and
// holds one session). The model is loaded on the first request and reloaded only
// when the request names another directory (the server restarted into another
// data folder). A load or run failure answers `{ id, error }` and the next
// request tries again; the process is not poisoned by one bad batch.
// =============================================================================

/** What the host needs of an embedder (`LocalEmbedder` of `@marinoscar/kvox-ai/local-embeddings`). */
export interface EmbedderModel {
  embed(texts: string[]): Promise<number[][]>;
  dispose(): Promise<void>;
}

/** Options of {@link createEmbedderHost}. */
export interface EmbedderHostOptions {
  /** Loads the model installed at `modelPath`. */
  load(modelPath: string): Promise<EmbedderModel>;
  /** Sends one response to the main process. */
  send(response: EmbedderResponse): void;
}

/** The embedder process's request handler. */
export function createEmbedderHost(options: EmbedderHostOptions): { handle(request: EmbedderRequest): Promise<void> } {
  let loaded: { path: string; model: Promise<EmbedderModel> } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const modelFor = async (path: string): Promise<EmbedderModel> => {
    if (loaded && loaded.path !== path) {
      const old = loaded.model;
      loaded = null;
      await old.then((model) => model.dispose()).catch(() => undefined);
    }
    if (!loaded) {
      const model = options.load(path);
      loaded = { path, model };
      // A failed load is not kept: the next request loads again.
      model.catch(() => {
        if (loaded?.model === model) loaded = null;
      });
    }
    return loaded.model;
  };

  const run = async (request: EmbedderRequest): Promise<void> => {
    try {
      if (!Array.isArray(request.texts) || typeof request.modelPath !== 'string' || request.modelPath === '') {
        throw new Error('A malformed embed request');
      }
      const model = await modelFor(request.modelPath);
      options.send({ id: request.id, vectors: await model.embed(request.texts) });
    } catch (error) {
      options.send({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    handle(request) {
      const next = chain.then(() => run(request));
      chain = next;
      return next;
    },
  };
}
