import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLocalEmbedder } from '@marinoscar/kvox-ai/local-embeddings';

import { createEmbedderHost } from './embedder-host';
import { unpackedRuntimeFile } from './embedder-paths';
import type { EmbedderRequest } from '../shared/protocol';

// =============================================================================
// The on-device embedder: a utility process of its own (marinoscar/kvox#660)
// =============================================================================
//
// `utilityProcess.fork(out/main/embedder.js)`, forked lazily by the main process on
// the first embed request and stopped after an idle time (`embedder-broker.ts`).
// It runs `createLocalEmbedder` of `@marinoscar/kvox-ai/local-embeddings`
// (onnxruntime-web on WASM, one thread), which BLOCKS this process's event loop
// while the model runs: that is why it is not the server's. Requests arrive as
// `{ id, modelPath, texts }` on `process.parentPort` and are answered with
// `{ id, vectors }` or `{ id, error }`, one batch at a time (`embedder-host.ts`).
//
// ASAR. onnxruntime-web loads its WASM glue (`ort-wasm-simd-threaded.mjs`) with a
// dynamic `import()`, which is not safe from inside `app.asar` in a utility process.
// electron-builder.yml unpacks that file (and the wasm) into `app.asar.unpacked`, and
// when this process runs from an archive it points the runtime there (`wasmPaths`).
// The package reads the `.wasm` itself with `fs`, which Electron's asar layer serves.
// =============================================================================

const parentPort = process.parentPort;

/** Points onnxruntime-web's glue import at the unpacked copy when running from an archive. */
function pointGlueAtUnpackedCopy(): void {
  const distDirectory = dirname(require.resolve('onnxruntime-web'));
  const glue = unpackedRuntimeFile(join(distDirectory, 'ort-wasm-simd-threaded.mjs'));
  if (glue === null) return; // a development checkout: the default location works
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort = require('onnxruntime-web') as { env: { wasm: { wasmPaths?: unknown } } };
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(glue).href };
}

const host = createEmbedderHost({
  load(modelPath) {
    pointGlueAtUnpackedCopy();
    return createLocalEmbedder({ modelPath, numThreads: 1 });
  },
  send: (response) => parentPort.postMessage(response),
});

parentPort.on('message', (event: { data: EmbedderRequest }) => {
  void host.handle(event.data);
});
