import { join } from 'node:path';

import { utilityProcess } from 'electron';

import type { FromServer } from '../shared/protocol';

// =============================================================================
// Migration commands as utility processes (marinoscar/kvox#587)
// =============================================================================
//
// The server runs `prisma migrate deploy` and `kvox-db check` as processes of
// their own. The packaged binary's RunAsNode fuse is OFF (ELECTRON_RUN_AS_NODE
// would let anyone run code as KVox), so the Electron binary cannot be spawned
// as Node; a utility process runs a Node script the same way (through
// `node-script-host.ts`, which also ends it), and only the main process may
// fork one. Output is collected and answered whole.
// =============================================================================

type RunNode = Extract<FromServer, { type: 'run-node' }>;

/** Runs one script to its end: its exit code and everything it printed. */
export function runNodeScript(request: RunNode): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = utilityProcess.fork(join(__dirname, 'node-script-host.js'), [request.script, ...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: 'pipe',
      serviceName: 'KVox migrations',
    });
    // Answered once the process exited AND both pipes are drained (the server parses the output).
    const drained = [child.stdout, child.stderr].map(
      (stream) =>
        new Promise<void>((done) => {
          if (!stream) return done();
          stream.on('data', (chunk: Buffer) => (output += chunk.toString()));
          stream.once('end', () => done());
          stream.once('error', () => done());
        }),
    );
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    void Promise.all([exited, ...drained]).then(([code]) => resolve({ code, output }));
  });
}
