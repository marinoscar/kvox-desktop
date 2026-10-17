import type { FromServer, ToServer } from '../shared/protocol';
import { startServer, type RunningServer } from './bootstrap.js';

// =============================================================================
// The server utility process (Electron `utilityProcess.fork`)
// =============================================================================
//
// Waits for the main process's `start` message, starts the local server and
// answers `ready` with its port, or `error`. On `stop` it closes the job loop,
// the server, Prisma and PGlite (which flushes its files) and answers `stopped`.
// =============================================================================

const port = process.parentPort;
const send = (message: FromServer): void => port.postMessage(message);

let server: RunningServer | undefined;

port.on('message', (event: { data: ToServer }) => {
  const message = event.data;
  if (message.type === 'start') {
    startServer({ ...message, log: (line) => send({ type: 'log', line }) })
      .then((running) => {
        server = running;
        send({ type: 'ready', port: running.port, userId: running.userId, permissions: [...running.permissions], timings: running.timings });
      })
      .catch((error: unknown) => {
        send({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      });
  } else if (message.type === 'stop') {
    void (server?.close() ?? Promise.resolve())
      .catch((error: unknown) => send({ type: 'log', line: `server: close failed: ${String(error)}` }))
      .finally(() => {
        send({ type: 'stopped' });
        process.exit(0);
      });
  }
});
