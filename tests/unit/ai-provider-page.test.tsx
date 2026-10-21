// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';
import { COPILOT_CONSENT_COPY } from '@marinoscar/kvox-web/copilot/headless';
import { KvoxWebHostProvider } from '@marinoscar/kvox-web/core/headless';

import type { DesktopConnection, KvoxDesktopBridge } from '../../src/shared/protocol';
import { createDesktopHost } from '../../src/renderer/src/host';
import { AiProviderCard } from '../../src/renderer/src/settings/AiProviderCard';

// =============================================================================
// The AI provider page: one choice of three, then the chosen provider's setup
// =============================================================================
//
// The real page (and the packaged Copilot and key cards) rendered in jsdom over the
// real renderer host, against a stubbed `fetch` that plays the local server's
// `/api/desktop/ai/*` routes with the rules the server enforces (tests/unit/
// desktop-ai.test.ts proves those): the provider is never off, choosing Copilot
// without the current consent is 409, accepting the consent through
// `PATCH /desktop/ai/copilot` chooses Copilot, withdrawing it goes back to OpenAI.
// It proves the page's bindings: three options and no Off, a choice applies at
// once, Copilot's consent comes first (Not now reverts, Agree selects), and only
// the chosen provider's setup renders.
// =============================================================================

const CONNECTION: DesktopConnection = {
  baseUrl: 'http://127.0.0.1:4999',
  token: 'test-token',
  userId: 'local-user',
  permissions: [],
  displayName: 'Ada',
};

type Provider = 'openai' | 'openai-compatible' | 'copilot';

interface FakeState {
  provider: Provider;
  openai: { model: string };
  openaiCompatible: { baseUrl: string | null; model: string | null; apiStyle: 'chat_completions' | 'responses'; requiresKey: boolean };
  copilot: { enabled: boolean; consentedAt: string | null; consentVersion: string | null; model: string | null };
  keys: Record<'openai' | 'openai-compatible', boolean>;
  signedIn: boolean;
}

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const consented = (state: FakeState) => Boolean(state.copilot.consentedAt) && state.copilot.consentVersion === COPILOT_CONSENT_VERSION;

function hostsOf(state: FakeState): string[] {
  if (state.provider === 'openai') return ['api.openai.com'];
  if (state.provider === 'openai-compatible') return [];
  return [...(consented(state) ? ['api.githubcopilot.com'] : []), ...(state.keys.openai ? ['api.openai.com'] : [])];
}

function keyStatus(configured: boolean) {
  return configured ? { configured: true, hint: 'abcd', updatedAt: '2026-10-21T00:00:00.000Z' } : { configured: false, hint: null, updatedAt: null };
}

function settingsView(state: FakeState) {
  const { keys: _keys, signedIn: _signedIn, ...settings } = state;
  return {
    settings: { ...settings, copilot: { ...settings.copilot, enabled: state.provider === 'copilot' } },
    providers: [
      { id: 'openai', label: 'OpenAI', implemented: true, primary: true, toolCalling: true, note: 'Your OpenAI API key.', needsKey: true, key: keyStatus(state.keys.openai) },
      {
        id: 'openai-compatible',
        label: 'OpenAI-compatible server',
        implemented: true,
        primary: true,
        toolCalling: true,
        note: 'A server that speaks the OpenAI API.',
        needsKey: state.openaiCompatible.requiresKey,
        key: keyStatus(state.keys['openai-compatible']),
      },
      { id: 'copilot', label: 'GitHub Copilot', implemented: true, primary: true, toolCalling: false, note: 'Your Copilot subscription.', needsKey: false, key: null },
    ],
    allowedHosts: hostsOf(state),
  };
}

function copilotStatus(state: FakeState) {
  return {
    enabled: state.provider === 'copilot' && consented(state),
    signedIn: state.signedIn,
    login: state.signedIn ? 'octocat' : null,
    runtime: { state: 'ready', version: '1.0.0', progress: null },
    models: [{ id: 'gpt-mock', label: 'GPT mock', structuredOutput: 'native' }],
    unavailableTasks: state.keys.openai ? [] : [{ task: 'ask.respond', reason: 'needs_tool_calling' }],
    allowedHosts: hostsOf(state),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function install(initial: Partial<FakeState> = {}): { state: FakeState; requests: Recorded[] } {
  const state: FakeState = {
    provider: 'openai',
    openai: { model: 'gpt-4.1-mini' },
    openaiCompatible: { baseUrl: null, model: null, apiStyle: 'chat_completions', requiresKey: true },
    copilot: { enabled: false, consentedAt: null, consentVersion: null, model: null },
    keys: { openai: false, 'openai-compatible': false },
    signedIn: false,
    ...initial,
  };
  const requests: Recorded[] = [];
  window.kvoxDesktop = { openExternal: async () => true } as unknown as KvoxDesktopBridge;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api/, '');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ method, path, body });

      if (path === '/desktop/ai/settings' && method === 'GET') return json(settingsView(state));
      if (path === '/desktop/ai/settings' && method === 'PATCH') {
        const patch = body as Partial<FakeState>;
        if (patch.provider === 'copilot' && !consented(state)) return json({ code: 'consent_required', message: 'Agree to the GitHub Copilot terms first.' }, 409);
        if (patch.provider) state.provider = patch.provider;
        if (patch.openai) state.openai = { ...state.openai, ...patch.openai };
        if (patch.openaiCompatible) state.openaiCompatible = { ...state.openaiCompatible, ...patch.openaiCompatible };
        return json(settingsView(state));
      }
      if (path === '/desktop/ai/copilot/status') return json(copilotStatus(state));
      if (path === '/desktop/ai/copilot' && method === 'PATCH') {
        const patch = body as Partial<FakeState['copilot']>;
        state.copilot = { ...state.copilot, ...patch };
        if (patch.enabled === true) {
          if (!consented(state)) return json({ code: 'consent_required', message: 'Agree first.' }, 409);
          state.provider = 'copilot';
        } else if (patch.enabled === false && state.provider === 'copilot') {
          state.provider = 'openai';
        }
        return json(copilotStatus(state));
      }
      const key = /^\/desktop\/ai\/keys\/(openai|openai-compatible)(\/test)?$/.exec(path);
      if (key) {
        const id = key[1] as 'openai' | 'openai-compatible';
        if (key[2]) {
          return json({
            success: true,
            provider: id,
            usedStoredKey: !(body as { apiKey?: string } | undefined)?.apiKey,
            modelCount: 1,
            smokeModelId: null,
            checks: [{ id: 'credentials', label: 'Credentials', status: 'passed', code: 'OK', detail: '', error: null }],
            attemptedAt: new Date().toISOString(),
          });
        }
        state.keys[id] = method === 'PUT';
        return json(keyStatus(state.keys[id]));
      }
      return json({ message: 'not found' }, 404);
    }),
  );
  return { state, requests };
}

function renderPage(): void {
  render(
    <KvoxWebHostProvider host={createDesktopHost(CONNECTION, true)}>
      <AiProviderCard />
    </KvoxWebHostProvider>,
  );
}

const group = () => screen.getByRole('radiogroup', { name: 'AI provider' });
const radio = (name: string) => within(group()).getByRole('radio', { name });
const patches = (requests: Recorded[], path: string) => requests.filter((request) => request.method === 'PATCH' && request.path === path);
/** The status line under the choice (each setup form has its own). */
const choiceStatus = () => within(screen.getByRole('region', { name: 'Choose your AI provider' })).getByRole('status');
const consentDialog = () => screen.queryByRole('dialog', { name: COPILOT_CONSENT_COPY.title });

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('choosing the AI provider', () => {
  it('offers exactly OpenAI, an OpenAI-compatible server and GitHub Copilot, with no Off and no global Save', async () => {
    install();
    renderPage();
    await screen.findByRole('radiogroup', { name: 'AI provider' });
    expect(within(group()).getAllByRole('radio').map((option) => option.getAttribute('aria-label'))).toEqual([
      'OpenAI',
      'OpenAI-compatible server',
      'GitHub Copilot',
    ]);
    expect(within(group()).queryByRole('radio', { name: /off/i })).toBeNull();
    expect(screen.queryByText(/no AI features/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save AI settings' })).toBeNull();
    expect((radio('OpenAI') as HTMLInputElement).checked).toBe(true);
    // One line under each name, and the hosts footer once.
    expect(screen.getByText('Uses your OpenAI API key.')).toBeTruthy();
    expect(screen.getAllByText(/KVox may connect only to/)).toHaveLength(1);
    expect(screen.getByText('Besides this device, KVox may connect only to: api.openai.com.')).toBeTruthy();
  });

  it('applies a choice at once, with one status line', async () => {
    const { requests } = install({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama', apiStyle: 'chat_completions', requiresKey: false } });
    renderPage();
    await screen.findByRole('heading', { name: 'Set up OpenAI-compatible server' });

    fireEvent.click(radio('OpenAI'));
    await waitFor(() => expect(patches(requests, '/desktop/ai/settings').map((request) => request.body)).toEqual([{ provider: 'openai' }]));
    await screen.findByRole('heading', { name: 'Set up OpenAI' });
    expect(choiceStatus().textContent).toBe('Using OpenAI.');
    expect((radio('OpenAI') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(radio('OpenAI-compatible server'));
    await screen.findByRole('heading', { name: 'Set up OpenAI-compatible server' });
    expect(patches(requests, '/desktop/ai/settings').map((request) => request.body)).toEqual([{ provider: 'openai' }, { provider: 'openai-compatible' }]);
    expect(choiceStatus().textContent).toBe('Using OpenAI-compatible server.');
    // Switching kept the server's settings.
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('http://127.0.0.1:11434/v1');
  });

  it('marks the chosen provider Ready once it can serve calls, else Needs setup', async () => {
    install();
    renderPage();
    await screen.findByRole('radiogroup', { name: 'AI provider' });
    expect(within(group()).getByText('Needs setup')).toBeTruthy();
    expect(within(group()).queryByText('Ready')).toBeNull();
    cleanup();

    install({ keys: { openai: true, 'openai-compatible': false } });
    renderPage();
    await screen.findByRole('radiogroup', { name: 'AI provider' });
    expect(within(group()).getByText('Ready')).toBeTruthy();
    // Only the selected option carries a status.
    expect(within(group()).getAllByText(/^(Ready|Needs setup)$/)).toHaveLength(1);
  });
});

describe('choosing GitHub Copilot', () => {
  it('asks for the consent first: Not now puts the radio back, Agree makes it the provider', async () => {
    const { requests, state } = install();
    renderPage();
    await screen.findByRole('radiogroup', { name: 'AI provider' });

    fireEvent.click(radio('GitHub Copilot'));
    await waitFor(() => expect(consentDialog()).not.toBeNull());
    // Nothing is saved until the user answers.
    expect(patches(requests, '/desktop/ai/settings')).toEqual([]);
    expect(patches(requests, '/desktop/ai/copilot')).toEqual([]);

    fireEvent.click(within(consentDialog()!).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(consentDialog()).toBeNull());
    expect((radio('OpenAI') as HTMLInputElement).checked).toBe(true);
    expect((radio('GitHub Copilot') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('heading', { name: 'Set up OpenAI' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'GitHub Copilot sign-in' })).toBeNull();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);

    fireEvent.click(radio('GitHub Copilot'));
    await waitFor(() => expect(consentDialog()).not.toBeNull());
    fireEvent.click(within(consentDialog()!).getByRole('button', { name: COPILOT_CONSENT_COPY.acceptSelectedLabel }));
    await waitFor(() => expect(state.provider).toBe('copilot'));
    expect(patches(requests, '/desktop/ai/copilot').map((request) => request.body)).toEqual([
      { enabled: true, consentedAt: expect.any(String), consentVersion: COPILOT_CONSENT_VERSION },
    ]);
    await screen.findByRole('heading', { name: 'Set up GitHub Copilot' });
    await waitFor(() => expect((radio('GitHub Copilot') as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect(choiceStatus().textContent).toBe('Using GitHub Copilot.'));
    expect(consentDialog()).toBeNull();
    // The page owns the choice: the card has no switch.
    expect(screen.queryByLabelText('Enable GitHub Copilot')).toBeNull();
    // The Copilot hosts in the one footer.
    await screen.findByText('Besides this device, KVox may connect only to: api.githubcopilot.com.');
    expect(screen.getAllByText(/KVox may connect only to/)).toHaveLength(1);
  });

  it('chooses Copilot at once when the consent is current', async () => {
    const { requests } = install({ copilot: { enabled: false, consentedAt: '2026-10-01T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: null } });
    renderPage();
    await screen.findByRole('radiogroup', { name: 'AI provider' });
    fireEvent.click(radio('GitHub Copilot'));
    await screen.findByRole('heading', { name: 'Set up GitHub Copilot' });
    expect(patches(requests, '/desktop/ai/settings').map((request) => request.body)).toEqual([{ provider: 'copilot' }]);
    await screen.findByRole('region', { name: 'GitHub Copilot sign-in' });
    expect(consentDialog()).toBeNull();
  });

  it('withdrawing the consent goes back to OpenAI', async () => {
    install({
      provider: 'copilot',
      signedIn: true,
      copilot: { enabled: true, consentedAt: '2026-10-01T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: 'gpt-mock' },
    });
    renderPage();
    const card = await screen.findByRole('region', { name: 'GitHub Copilot sign-in' });
    await waitFor(() => expect(within(group()).getByText('Ready')).toBeTruthy());
    fireEvent.click(await within(card).findByRole('button', { name: 'Withdraw consent' }));
    await screen.findByRole('heading', { name: 'Set up OpenAI' });
    expect((radio('OpenAI') as HTMLInputElement).checked).toBe(true);
    expect(choiceStatus().textContent).toBe('Using OpenAI.');
    expect(screen.queryByRole('region', { name: 'GitHub Copilot sign-in' })).toBeNull();
  });
});

describe('setting up the chosen provider', () => {
  it('OpenAI: the key card and the model, saved on its own; nothing of the other providers', async () => {
    const { requests } = install();
    renderPage();
    await screen.findByRole('heading', { name: 'Set up OpenAI' });
    expect(screen.getByRole('region', { name: 'OpenAI key' })).toBeTruthy();
    expect(screen.queryByLabelText('Base URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save server settings' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'GitHub Copilot sign-in' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Optional: an OpenAI key for Ask' })).toBeNull();

    const save = screen.getByRole('button', { name: 'Save model' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('Model saved.');
    expect(patches(requests, '/desktop/ai/settings').map((request) => request.body)).toEqual([{ openai: { model: 'gpt-5' } }]);
    expect(save.disabled).toBe(true);
  });

  it('OpenAI-compatible: the server settings with their own Save, then the key card once the server is saved', async () => {
    const { requests } = install({ provider: 'openai-compatible' });
    renderPage();
    await screen.findByRole('heading', { name: 'Set up OpenAI-compatible server' });
    expect(screen.queryByRole('region', { name: 'OpenAI-compatible server key' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'OpenAI key' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Optional: an OpenAI key for Ask' })).toBeNull();
    expect(screen.getByText('KVox connects to nothing outside this device.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://127.0.0.1:11434/v1' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'llama' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save server settings' }));
    await screen.findByText('Server settings saved.');
    expect(patches(requests, '/desktop/ai/settings').map((request) => request.body)).toEqual([
      { openaiCompatible: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama', apiStyle: 'chat_completions', requiresKey: true } },
    ]);
    await screen.findByRole('region', { name: 'OpenAI-compatible server key' });
  });

  it('Copilot: its card, then the optional OpenAI key for Ask', async () => {
    install({ provider: 'copilot', copilot: { enabled: true, consentedAt: '2026-10-01T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: null } });
    renderPage();
    await screen.findByRole('heading', { name: 'Set up GitHub Copilot' });
    await screen.findByRole('region', { name: 'GitHub Copilot sign-in' });
    const ask = screen.getByRole('region', { name: 'Optional: an OpenAI key for Ask' });
    expect(within(ask).getByText(/Copilot can't run Ask, because Ask needs tool calling/)).toBeTruthy();
    expect(within(ask).getByRole('region', { name: 'OpenAI key' })).toBeTruthy();
    expect(screen.queryByLabelText('Base URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save model' })).toBeNull();
    // Signed out: chosen, but not ready.
    expect(within(group()).getByText('Needs setup')).toBeTruthy();
  });

  it('Copilot: the first OpenAI key for Ask is stored, then tested (the guard allows OpenAI only once a key is stored)', async () => {
    const { requests, state } = install({
      provider: 'copilot',
      copilot: { enabled: true, consentedAt: '2026-10-01T00:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: null },
    });
    renderPage();
    const ask = await screen.findByRole('region', { name: 'Optional: an OpenAI key for Ask' });
    const keyCard = within(ask).getByRole('region', { name: 'OpenAI key' });
    fireEvent.change(within(keyCard).getByLabelText('API key'), { target: { value: 'sk-test-0123456789abcdef' } });
    fireEvent.click(within(keyCard).getByRole('button', { name: 'Save & verify' }));
    await within(keyCard).findByText('Key verified and saved.');
    expect(state.keys.openai).toBe(true);
    const keyCalls = requests.filter((request) => request.path.startsWith('/desktop/ai/keys/')).map((request) => `${request.method} ${request.path}`);
    expect(keyCalls).toEqual(['PUT /desktop/ai/keys/openai', 'POST /desktop/ai/keys/openai/test']);
    // The footer follows: api.openai.com joins the Copilot hosts.
    await screen.findByText('Besides this device, KVox may connect only to: api.githubcopilot.com, api.openai.com.');
  });
});
