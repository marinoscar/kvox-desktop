import type { FromServer, ToServer } from '../shared/protocol';
import { startServer, type RunningServer } from './bootstrap.js';
import { MainBridge } from './main-bridge.js';

// =============================================================================
// The server utility process (Electron `utilityProcess.fork`)
// =============================================================================
//
// Waits for the main process's `start` message, starts the local server and
// answers `ready` with its port, or `error`. On `stop` it closes the job loop,
// the server, Prisma and PGlite (which flushes its files) and answers `stopped`.
// `secrets-result` messages answer the server's `safeStorage` requests.
// =============================================================================

const port = process.parentPort;
const send = (message: FromServer): void => port.postMessage(message);
const bridge = new MainBridge(send);

let server: RunningServer | undefined;

port.on('message', (event: { data: ToServer }) => {
  const message = event.data;
  if (bridge.handle(message)) return;
  if (message.type === 'start') {
    startServer({
      ...message,
      log: (line) => send({ type: 'log', line }),
      logError: (line) => send({ type: 'log', line, level: 'error' }),
      cipher: bridge.cipher,
      runNodeScript: bridge.runNodeScript,
      showNotification: (title, body) => bridge.notify(title, body),
      requestRestart: (reason) => bridge.restart(reason),
    })
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
