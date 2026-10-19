import { describe, expect, it, vi } from 'vitest';

import type { KvoxWebHost } from '@marinoscar/kvox-web/core/headless';

import { ASK_TASK, isAskUnavailable } from '../../src/renderer/src/askAvailability';
import { allowedHostsOf, createCopilotPort } from '../../src/renderer/src/settings/copilotPort';

// =============================================================================
// The Copilot port and the Ask entry's rule (marinoscar/kvox-desktop#22)
// =============================================================================
// The port only maps the packaged hook's six calls to /api/desktop/ai/copilot/*;
// these tests pin the routes, the methods, the abort behaviour the hook relies on
// and that nothing but the server's status is exposed.
// =============================================================================

type Call = { method: string; path: string; init?: { body?: unknown; signal?: AbortSignal } };

const status = (state: 'missing' | 'downloading' | 'ready' | 'error', extra: Record<string, unknown> = {}) => ({
  enabled: true,
  signedIn: false,
  login: null,
  runtime: { state, version: null, progress: null },
  models: [],
  unavailableTasks: [],
  allowedHosts: ['api.githubcopilot.com'],
  ...extra,
});

function fakeHost(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const request = vi.fn(async (method: string, path: string, init?: Call['init']) => {
    const call = { method, path, init };
    calls.push(call);
    return answer(call);
  });
  return { host: { http: { request } } as unknown as KvoxWebHost, calls };
}

describe('createCopilotPort', () => {
  it('reads the status and the stored setting from the server', async () => {
    const { host, calls } = fakeHost((call) =>
      call.path === '/desktop/ai/settings' ? { settings: { copilot: { enabled: true, consentedAt: 'x', consentVersion: '1', model: 'm' } } } : status('ready'),
    );
    const port = createCopilotPort(host);
    expect((await port.getStatus()).runtime.state).toBe('ready');
    expect(await port.getSettings()).toEqual({ enabled: true, consentedAt: 'x', consentVersion: '1', model: 'm' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /desktop/ai/copilot/status', 'GET /desktop/ai/settings']);
  });

  it('PATCHes the consent patch as given and resolves to the stored setting', async () => {
    const patch = { enabled: true, consentedAt: '2026-10-19T00:00:00.000Z', consentVersion: '1' };
    const { host, calls } = fakeHost((call) => (call.method === 'PATCH' ? status('ready') : { settings: { copilot: { ...patch, model: null } } }));
    expect(await createCopilotPort(host).update(patch)).toEqual({ ...patch, model: null });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/desktop/ai/copilot', init: { body: patch } });
  });

  it('maps sign-in, sign-out and the long-poll wait, handing the wait its abort signal', async () => {
    const challenge = { kind: 'device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: '2026-10-19T01:00:00Z' };
    const { host, calls } = fakeHost((call) => (call.path.endsWith('/sign-in') ? challenge : status('ready', { signedIn: true, login: 'octo' })));
    const port = createCopilotPort(host);
    expect(await port.startSignIn()).toEqual(challenge);
    const controller = new AbortController();
    await port.waitForSignIn(controller.signal);
    await port.signOut();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /desktop/ai/copilot/sign-in',
      'POST /desktop/ai/copilot/sign-in/wait',
      'POST /desktop/ai/copilot/sign-out',
    ]);
    expect(calls[1]?.init?.signal).toBe(controller.signal);
  });

  it('lets the wait reject when the request is aborted', async () => {
    const host = {
      http: {
        request: (_method: string, _path: string, init?: Call['init']) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))),
      },
    } as unknown as KvoxWebHost;
    const controller = new AbortController();
    const waiting = createCopilotPort(host).waitForSignIn(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('starts the download and returns: the card follows the status, and DELETE cancels', async () => {
    const { host, calls } = fakeHost(() => status('downloading'));
    const port = createCopilotPort(host);
    await port.downloadRuntime(new AbortController().signal);
    await port.cancelRuntimeDownload();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /desktop/ai/copilot/runtime/download',
      'DELETE /desktop/ai/copilot/runtime/download',
    ]);
  });

  it('passes a refused download (409 runtime_download_unavailable) to the card', async () => {
    const refusal = Object.assign(new Error('No download is configured.'), { code: 'runtime_download_unavailable', status: 409 });
    const host = { http: { request: vi.fn().mockRejectedValue(refusal) } } as unknown as KvoxWebHost;
    await expect(createCopilotPort(host).downloadRuntime(new AbortController().signal)).rejects.toBe(refusal);
  });
});

describe('allowedHostsOf', () => {
  it('reads the hosts the server answers, and none when absent', () => {
    expect(allowedHostsOf(status('ready') as never)).toEqual(['api.githubcopilot.com']);
    expect(allowedHostsOf({ ...status('ready'), allowedHosts: undefined } as never)).toEqual([]);
  });
});

describe('isAskUnavailable', () => {
  it('is true only when the server lists ask.respond', () => {
    expect(ASK_TASK).toBe('ask.respond');
    expect(isAskUnavailable([{ task: 'ask.respond', reason: 'needs_tool_calling' }])).toBe(true);
    expect(isAskUnavailable([{ task: 'search.embed', reason: 'needs_embeddings' }])).toBe(false);
    expect(isAskUnavailable([])).toBe(false);
    expect(isAskUnavailable(undefined)).toBe(false);
  });
});
