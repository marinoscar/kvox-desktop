import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeGraphConformance } from '@marinoscar/kvox-api/graph/testing';
import { describeGraphExtractionConformance } from '@marinoscar/kvox-api/graph-extraction/testing';
import { describeGraphRdfConformance } from '@marinoscar/kvox-api/graph-rdf/testing';

import { startServer, type RunningServer } from '../../src/server/bootstrap';
import { spawnNodeScript, type NodeScriptRequest } from '../../src/server/database';
import { utilityProcessShaclRun } from '../../src/server/shacl-runner';
import { ROOT, fakeCipher, removeQuietly } from './support/database';

// =============================================================================
// The graph's host duties (marinoscar/kvox#586)
// =============================================================================
//
//   - `shacl.run`: the input goes to the script as a file, the report comes
//     back from the file it writes, both are removed, a failed run is an error;
//   - the server as bootstrap starts it: the graph and Ask routes answer for the
//     local user, `ai.graphEnabled` is on, `/desktop/knowledge` turns it off
//     (409 `graph_disabled`) and on again (#620), and one housekeeping round
//     calls the four enqueuers;
//   - the slices' own conformance kits over the handlers that server registered
//     (job types, profiles, server-only AI jobs, a `sensitive` PersonFact never
//     embedded or exported, rate limits), with nothing opted out.
// =============================================================================

describe('utilityProcessShaclRun', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kvox-shacl-'));
  afterAll(() => removeQuietly(tmpDir));

  it('hands the input over as a file and answers the report the script wrote', async () => {
    const seen: NodeScriptRequest[] = [];
    const run = utilityProcessShaclRun({
      appRoot: ROOT,
      scriptPath: '/app/out/main/shacl-validate.js',
      tmpDir,
      run: async (request) => {
        seen.push(request);
        const [input, report] = request.args;
        writeFileSync(report, JSON.stringify({ echoed: JSON.parse(readFileSync(input, 'utf8')) }));
        return { code: 0, output: '' };
      },
    });

    const report = await run('{"maxResults":5}', { signal: new AbortController().signal });

    expect(JSON.parse(report)).toEqual({ echoed: { maxResults: 5 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].script).toBe('/app/out/main/shacl-validate.js');
    for (const path of seen[0].args) expect(path.startsWith(join(tmpDir, 'shacl'))).toBe(true);
    expect(readdirSync(join(tmpDir, 'shacl'))).toEqual([]);
  });

  it('turns a failed run into an error and still removes its files', async () => {
    const run = utilityProcessShaclRun({
      appRoot: ROOT,
      scriptPath: 'shacl-validate.js',
      tmpDir,
      run: async () => ({ code: 1, output: 'engine failed' }),
    });

    await expect(run('{}', { signal: new AbortController().signal })).rejects.toThrow('exit 1: engine failed');
    expect(readdirSync(join(tmpDir, 'shacl'))).toEqual([]);
  });
});

describe('the graph and Ask on the Desktop server', () => {
  const TOKEN = randomBytes(32).toString('base64url');
  let userDataDir: string;
  let server: RunningServer;

  async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
    });
    const text = await response.text();
    const body = text === '' ? null : JSON.parse(text);
    return { status: response.status, body: (body?.data ?? body) as T };
  }

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kvox-graph-'));
    server = await startServer({
      appRoot: ROOT,
      userDataDir,
      runNodeScript: spawnNodeScript(process.execPath),
      token: TOKEN,
      allowedOrigins: ['kvox://app'],
      log: () => undefined,
      appVersion: '0.0.0-test',
      cipher: fakeCipher(),
      showNotification: () => undefined,
      requestRestart: () => undefined,
    });
  });

  afterAll(async () => {
    await server?.close().catch(() => undefined);
    removeQuietly(userDataDir);
  });

  it('gives the local user the graph permissions, which Ask needs too', () => {
    expect(server.permissions).toEqual(expect.arrayContaining(['graph:read', 'graph:write']));
  });

  it('answers the graph, Review and Ask routes', async () => {
    expect((await api('/graph/entities?type=Person')).status).toBe(200);
    expect((await api('/graph/proposals?status=draft')).status).toBe(200);
    expect((await api('/graph/overview')).status).toBe(200);
    expect((await api('/ask/conversations')).status).toBe(200);
  });

  it('has connected knowledge on: the graph AI routes do not answer graph_disabled', async () => {
    // No AI provider is configured, so extraction is refused, but for the provider, not the switch.
    const response = await api<{ code?: string; details?: { reason?: string } }>(
      '/graph/notes/00000000-0000-4000-8000-0000000000aa/extract',
      { method: 'POST', body: '{}' },
    );
    expect(JSON.stringify(response.body)).not.toContain('graph_disabled');
  });

  it('turns connected knowledge off and on again through /desktop/knowledge (#620)', async () => {
    // Asking checks the switch before anything else but the conversation (ask-messages.service).
    const conversation = await api<{ id: string }>('/ask/conversations', { method: 'POST', body: '{}' });
    expect(conversation.status).toBe(201);
    const ask = () =>
      api<unknown>(`/ask/conversations/${conversation.body.id}/messages`, { method: 'POST', body: JSON.stringify({ content: 'Who is Joe?' }) });
    expect((await api('/desktop/knowledge')).body).toEqual({ graphEnabled: true });

    const off = await api('/desktop/knowledge', { method: 'PATCH', body: JSON.stringify({ graphEnabled: false }) });
    expect(off).toEqual({ status: 200, body: { graphEnabled: false } });
    expect((await api('/desktop/knowledge')).body).toEqual({ graphEnabled: false });
    const disabled = await ask();
    expect(disabled.status).toBe(409);
    expect(JSON.stringify(disabled.body)).toContain('graph_disabled');
    // Reading one's own graph is not an AI call: it still answers.
    expect((await api('/graph/entities?type=Person')).status).toBe(200);

    const on = await api('/desktop/knowledge', { method: 'PATCH', body: JSON.stringify({ graphEnabled: true }) });
    expect(on.body).toEqual({ graphEnabled: true });
    // No AI provider is configured: refused again, but for the provider, not the switch.
    expect(JSON.stringify((await ask()).body)).not.toContain('graph_disabled');
  });

  it('refuses a /desktop/knowledge patch that is not { graphEnabled: boolean }', async () => {
    for (const body of ['{}', '{"graphEnabled":"no"}', 'null']) {
      expect((await api('/desktop/knowledge', { method: 'PATCH', body })).status).toBe(400);
    }
    expect((await api('/desktop/knowledge')).body).toEqual({ graphEnabled: true });
  });

  it('runs one housekeeping round over the four enqueuers', async () => {
    const tick = await server.housekeeping.runOnce();
    expect(tick.kgMigrate).toBe('called');
    expect(tick.kgExportExpiry).toBe('called');
    expect(tick.transcripts).toBeTruthy();
    expect(tick.notes).toBeTruthy();
  });

  it('ships the SHACL script entry beside the server bundle', () => {
    // electron.vite.config.ts builds src/main/shacl-validate.ts to out/main/shacl-validate.js.
    const built = join(ROOT, 'out', 'main', 'server.js');
    if (existsSync(built)) expect(existsSync(join(ROOT, 'out', 'main', 'shacl-validate.js'))).toBe(true);
  });
});

// The handlers of a server started for the kits (its own data folder).
let kitServer: RunningServer | undefined;
let kitDataDir: string | undefined;
async function kitHandlers() {
  if (!kitServer) {
    kitDataDir = mkdtempSync(join(tmpdir(), 'kvox-graph-kits-'));
    kitServer = await startServer({
      appRoot: ROOT,
      userDataDir: kitDataDir,
      runNodeScript: spawnNodeScript(process.execPath),
      token: randomBytes(32).toString('base64url'),
      allowedOrigins: ['kvox://app'],
      log: () => undefined,
      appVersion: '0.0.0-test',
      cipher: fakeCipher(),
      showNotification: () => undefined,
      requestRestart: () => undefined,
    });
  }
  return { handlers: kitServer.jobHandlers() };
}
afterAll(async () => {
  await kitServer?.close().catch(() => undefined);
  if (kitDataDir) removeQuietly(kitDataDir);
});

describeGraphConformance('desktop', kitHandlers, { describe, it, expect });
describeGraphExtractionConformance('desktop', kitHandlers, { describe, it, expect });
describeGraphRdfConformance('desktop', kitHandlers, { describe, it, expect });
