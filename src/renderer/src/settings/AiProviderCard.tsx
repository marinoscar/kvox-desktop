import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { hasCopilotConsent } from '@marinoscar/kvox-web/copilot/headless';
import { KvoxApiError, useKvoxHost } from '@marinoscar/kvox-web/core/headless';
import type { AiProbeResult, UserAiKey } from '@marinoscar/platform-web/ai/headless';
import { KeylessProviderCard, UserAiKeyCard } from '@marinoscar/platform-web/ai/ui';

import { CopilotSection } from './CopilotSection';
import { allowedHostsOf } from './copilotPort';

// =============================================================================
// "AI provider": one choice of three, then the setup of the one chosen
// =============================================================================
//
// KVox always has an AI provider (there is no "off"): OpenAI, an OpenAI-compatible
// server, or GitHub Copilot. The page is three parts:
//
//   1. Choose your AI provider   three option cards (one radio group). Choosing
//                                applies at once: `PATCH /api/desktop/ai/settings
//                                {provider}`. GitHub Copilot needs the consent to
//                                the current text first: without it the choice is
//                                held here (`pendingCopilot`) while the Copilot
//                                card shows its consent dialog; Agree saves it
//                                (`PATCH /api/desktop/ai/copilot`, which makes
//                                Copilot the provider), Not now puts the radio back.
//   2. Set up <provider>         only the chosen provider's settings: OpenAI's key
//                                and model; the compatible server's URL, model, wire
//                                style and key; Copilot's packaged card
//                                (`CopilotSection.tsx`) and, optional, the OpenAI key
//                                search by meaning uses (Copilot offers no embeddings).
//   3. One footer                the hosts the egress guard allows now.
//
// Switching provider never deletes another provider's key or settings.
//
// The key block is the platform's own `UserAiKeyCard` (Save & verify, Test,
// Re-check, Remove) or, for a keyless server, its `KeylessProviderCard`; this file
// only binds them to the server (marinoscar/kvox-desktop#19). The key is
// write-only: the server answers a status (saved or not, the last four
// characters, when), never the key. Testing a key is `POST
// /api/desktop/ai/keys/:provider/test`, answered by the server through the
// adapter's `verifyKey`. The compatible server's key card appears only once its
// URL is saved, so no test reaches a host the egress guard has not been told about.
// =============================================================================

type ProviderId = 'openai' | 'openai-compatible' | 'copilot';
type CompatibleSettings = { baseUrl: string | null; model: string | null; apiStyle: 'chat_completions' | 'responses'; requiresKey: boolean };

interface AiSettings {
  provider: ProviderId;
  openai: { model: string };
  openaiCompatible: CompatibleSettings;
  copilot: { enabled: boolean; consentedAt: string | null; consentVersion: string | null; model: string | null };
}

interface KeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

interface SettingsView {
  settings: AiSettings;
  providers: Array<{ id: string; label: string; implemented: boolean; primary: boolean; toolCalling: boolean; note: string; needsKey: boolean; key: KeyStatus | null }>;
  allowedHosts: string[];
}

/** What the last test of a key found; the server keeps no such record, so it lives for this visit. */
interface KeyCheck {
  verifiedAt: string | null;
  lastErrorCode: string | null;
  modelCount: number;
  checkedAt: string;
}

type Outcome = { severity: 'success' | 'error'; text: string };

/** The one line under each option's name (the server's `note` for a provider not listed here). */
const DESCRIPTIONS: Record<ProviderId, string> = {
  openai: 'Uses your OpenAI API key.',
  'openai-compatible': 'A server on this computer or your network that speaks the OpenAI API: Ollama, LM Studio, vLLM or a gateway.',
  copilot: 'Uses your own GitHub Copilot subscription after you sign in.',
};

const NO_KEY: KeyStatus = { configured: false, hint: null, updatedAt: null };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The status line or the error under a control: announced politely, or as an alert. */
function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (outcome?.severity === 'error') {
    return (
      <Alert severity="error" role="alert">
        {outcome.text}
      </Alert>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary" role="status">
      {outcome?.text ?? ''}
    </Typography>
  );
}

export function AiProviderCard() {
  const host = useKvoxHost();
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The freshest egress allowlist: from the settings view or a Copilot status, whichever came last.
  const [hosts, setHosts] = useState<string[]>([]);
  const [checks, setChecks] = useState<Record<string, KeyCheck>>({});
  // GitHub Copilot picked, its consent not answered yet: nothing is saved until Agree.
  const [pendingCopilot, setPendingCopilot] = useState(false);
  // The provider a PATCH is choosing right now (the radio shows it meanwhile).
  const [choosing, setChoosing] = useState<ProviderId | null>(null);
  const [choiceOutcome, setChoiceOutcome] = useState<Outcome | null>(null);
  const [copilotStatus, setCopilotStatus] = useState<CopilotStatus | null>(null);
  // Bumped when an OpenAI key changes under Copilot: the card's capabilities (search by meaning) follow.
  const [copilotRefresh, setCopilotRefresh] = useState(0);
  const viewRef = useRef<SettingsView | null>(null);

  const apply = useCallback((next: SettingsView) => {
    viewRef.current = next;
    setView(next);
    setHosts(next.allowedHosts);
  }, []);

  const load = useCallback(async () => {
    const next = await host.http.request<SettingsView>('GET', '/desktop/ai/settings');
    apply(next);
    return next;
  }, [host, apply]);

  useEffect(() => {
    load().catch((error: unknown) => setLoadError(message(error)));
  }, [load]);

  const onCopilotStatus = useCallback((status: CopilotStatus) => {
    setCopilotStatus(status);
    setHosts(allowedHostsOf(status));
  }, []);

  if (loadError && !view) {
    return (
      <Alert severity="error" role="alert">
        {loadError}
      </Alert>
    );
  }
  if (!view) return <Typography variant="body2">Loading…</Typography>;

  const settings = view.settings;
  const saved = settings.provider;
  const slotOf = (id: string) => view.providers.find((provider) => provider.id === id);
  const labelOf = (id: ProviderId) => slotOf(id)?.label ?? id;
  const keyOf = (id: ProviderId) => slotOf(id)?.key ?? NO_KEY;
  // What the page sets up: the saved provider, or Copilot while its consent is being asked.
  const chosen: ProviderId = pendingCopilot ? 'copilot' : saved;
  const radioValue: ProviderId = choosing ?? chosen;

  const options = view.providers
    .filter((provider) => provider.implemented && provider.primary)
    .map((provider) => ({
      id: provider.id as ProviderId,
      label: provider.label,
      description: DESCRIPTIONS[provider.id as ProviderId] ?? provider.note,
    }));

  /** Whether the provider can serve calls now. */
  const isReady = (id: ProviderId): boolean => {
    if (id === 'openai') return keyOf('openai').configured;
    if (id === 'openai-compatible') {
      const compatible = settings.openaiCompatible;
      return Boolean(compatible.baseUrl && compatible.model) && (!compatible.requiresKey || keyOf('openai-compatible').configured);
    }
    return (
      saved === 'copilot' &&
      hasCopilotConsent(settings.copilot) &&
      copilotStatus?.enabled === true &&
      copilotStatus.runtime.state === 'ready' &&
      copilotStatus.signedIn
    );
  };

  // ---- Choosing the provider: applies at once ---------------------------------------------

  const saveProvider = async (id: ProviderId) => {
    setChoosing(id);
    setChoiceOutcome(null);
    try {
      apply(await host.http.request<SettingsView>('PATCH', '/desktop/ai/settings', { body: { provider: id } }));
      // The Copilot card is gone (or about to read anew): its last status says nothing now.
      setCopilotStatus(null);
      setChoiceOutcome({ severity: 'success', text: `Using ${labelOf(id)}.` });
    } catch (error) {
      setChoiceOutcome({ severity: 'error', text: message(error) });
    } finally {
      setChoosing(null);
    }
  };

  const choose = (id: ProviderId) => {
    if (choosing !== null) return;
    if (id === 'copilot' && !hasCopilotConsent(settings.copilot)) {
      // The Copilot card asks for the consent; Agree saves the choice, Not now undoes it.
      setChoiceOutcome(null);
      setPendingCopilot(true);
      return;
    }
    setPendingCopilot(false);
    if (id === saved) return;
    void saveProvider(id);
  };

  // Not now in the consent dialog: back to the saved provider (OpenAI when the saved one IS
  // Copilot with a consent to an older text).
  const declineCopilot = async () => {
    if (pendingCopilot && saved !== 'copilot') {
      setPendingCopilot(false);
      return;
    }
    setPendingCopilot(false);
    await saveProvider('openai');
  };

  // The Copilot card saved something (consent, withdrawal, model): the provider may have changed.
  const onCopilotChanged = async () => {
    const before = viewRef.current?.settings.provider;
    const next = await load();
    setPendingCopilot(false);
    if (next.settings.provider !== before) setChoiceOutcome({ severity: 'success', text: `Using ${labelOf(next.settings.provider)}.` });
  };

  // ---- The key card's bindings: the server holds the key; nothing comes back but a status ----

  const remember = (provider: string, result: AiProbeResult) =>
    setChecks((current) => ({
      ...current,
      [provider]: {
        verifiedAt: result.success ? result.attemptedAt : null,
        lastErrorCode: result.success ? null : (result.checks.find((check) => check.status === 'failed')?.code ?? null),
        modelCount: result.modelCount ?? 0,
        checkedAt: result.attemptedAt,
      },
    }));

  const testKey = async (provider: string, typedKey?: string): Promise<AiProbeResult> => {
    const result = await host.http.request<AiProbeResult>('POST', `/desktop/ai/keys/${provider}/test`, {
      body: typedKey === undefined ? {} : { apiKey: typedKey },
    });
    // A typed key is not stored yet: only a stored key's result describes the saved status.
    if (result.usedStoredKey) remember(provider, result);
    return result;
  };

  const keysChanged = async (provider: string) => {
    await load();
    if (provider === 'openai' && chosen === 'copilot') setCopilotRefresh((reads) => reads + 1);
  };

  const rejected = () => new KvoxApiError('The provider rejected this key.', 400, 'BAD_REQUEST', { reason: 'AI_KEY_INVALID' });

  // Save & verify: the provider must not reject the key (then nothing is stored). Any other
  // failure (offline, a gateway with no model list) still saves it and says it is unverified.
  const saveKey = async (provider: string, typedKey: string) => {
    // With Copilot as the provider, api.openai.com is allowed only once an OpenAI key is stored
    // (the egress guard), so the first OpenAI key is stored first and then tested; a rejected one
    // is removed again.
    const storeFirst = provider === 'openai' && saved === 'copilot' && !keyOf('openai').configured;
    if (storeFirst) {
      const stored = await host.http.request<KeyStatus>('PUT', `/desktop/ai/keys/${provider}`, { body: { apiKey: typedKey } });
      const probe = await host.http.request<AiProbeResult>('POST', `/desktop/ai/keys/${provider}/test`, { body: {} });
      const failure = probe.checks.find((check) => check.status === 'failed');
      if (failure?.code === 'AI_KEY_INVALID') {
        await host.http.request<KeyStatus>('DELETE', `/desktop/ai/keys/${provider}`);
        await keysChanged(provider);
        throw rejected();
      }
      remember(provider, probe);
      await keysChanged(provider);
      if (failure) throw new Error(`The key was saved, but it could not be verified: ${failure.detail || 'the provider did not answer.'}`);
      return keyView(provider, stored);
    }
    const probe = await host.http.request<AiProbeResult>('POST', `/desktop/ai/keys/${provider}/test`, { body: { apiKey: typedKey } });
    const failure = probe.checks.find((check) => check.status === 'failed');
    if (failure?.code === 'AI_KEY_INVALID') throw rejected();
    const status = await host.http.request<KeyStatus>('PUT', `/desktop/ai/keys/${provider}`, { body: { apiKey: typedKey } });
    remember(provider, probe);
    await keysChanged(provider);
    if (failure) throw new Error(`The key was saved, but it could not be verified: ${failure.detail || 'the provider did not answer.'}`);
    return keyView(provider, status);
  };

  const removeKey = async (provider: string) => {
    await host.http.request<KeyStatus>('DELETE', `/desktop/ai/keys/${provider}`);
    setChecks(({ [provider]: _removed, ...rest }) => rest);
    await keysChanged(provider);
  };

  const keyView = (provider: string, status: KeyStatus): UserAiKey => {
    const check = checks[provider];
    return {
      provider,
      configured: status.configured,
      hint: status.hint,
      verifiedAt: check?.verifiedAt ?? null,
      lastErrorCode: check?.lastErrorCode ?? null,
      reachableModelCount: check?.modelCount ?? 0,
      reachableCheckedAt: check?.checkedAt ?? null,
    };
  };

  const keyCard = (id: 'openai' | 'openai-compatible') => (
    <UserAiKeyCard
      provider={{ id, displayName: labelOf(id), hasOrgKey: false }}
      keyView={keyView(id, keyOf(id))}
      orgFallback={false}
      onSave={saveKey}
      onTest={testKey}
      onRemove={removeKey}
    />
  );

  const patchSettings = async (patch: Partial<AiSettings>) => {
    apply(await host.http.request<SettingsView>('PATCH', '/desktop/ai/settings', { body: patch }));
  };

  // ---- The page ---------------------------------------------------------------------

  let setup: ReactNode;
  if (chosen === 'openai') {
    setup = (
      <>
        {keyCard('openai')}
        <ModelSetting saved={settings.openai.model} onSave={(model) => patchSettings({ openai: { model } })} />
      </>
    );
  } else if (chosen === 'openai-compatible') {
    const compatible = settings.openaiCompatible;
    setup = (
      <>
        <CompatibleServerSettings saved={compatible} onSave={(next) => patchSettings({ openaiCompatible: next })} />
        {/* The key: only for a saved server, so the card never tests a host the egress guard does not know. */}
        {compatible.baseUrl &&
          (compatible.requiresKey ? (
            keyCard('openai-compatible')
          ) : (
            <KeylessProviderCard provider={{ id: 'openai-compatible', displayName: labelOf('openai-compatible') }} />
          ))}
      </>
    );
  } else {
    setup = (
      <>
        <CopilotSection onStatus={onCopilotStatus} onChanged={onCopilotChanged} onDecline={declineCopilot} refreshKey={copilotRefresh} />
        <Stack component="section" aria-labelledby="ai-copilot-embeddings-title" spacing={1.5}>
          <Box>
            <Typography id="ai-copilot-embeddings-title" variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
              Optional: an OpenAI key for search by meaning
            </Typography>
            <Typography variant="body2" color="text.secondary">
              GitHub Copilot runs notes, knowledge extraction, name checks and Ask. Search by meaning needs embeddings, which Copilot does
              not offer; save an OpenAI API key to turn it on.
            </Typography>
          </Box>
          {keyCard('openai')}
        </Stack>
      </>
    );
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 760 }}>
      <Stack component="section" aria-labelledby="ai-provider-choice-title" spacing={1.5}>
        <Typography id="ai-provider-choice-title" variant="h6" component="h2">
          Choose your AI provider
        </Typography>
        <RadioGroup aria-label="AI provider" value={radioValue} onChange={(event) => choose(event.target.value as ProviderId)} sx={{ gap: 1 }}>
          {options.map((option) => (
            <ProviderOption
              key={option.id}
              id={option.id}
              label={option.label}
              description={option.description}
              checked={radioValue === option.id}
              status={radioValue === option.id && choosing === null ? (isReady(option.id) ? 'ready' : 'setup') : null}
            />
          ))}
        </RadioGroup>
        <OutcomeLine outcome={choiceOutcome} />
      </Stack>

      <Stack component="section" aria-labelledby="ai-provider-setup-title" spacing={2}>
        <Typography id="ai-provider-setup-title" variant="h6" component="h2">
          Set up {labelOf(chosen)}
        </Typography>
        {setup}
      </Stack>

      {/* Search by meaning needs no provider: the on-device model has its own page (marinoscar/kvox#660). */}
      <Typography variant="body2" color="text.secondary">
        Search by meaning can run on this device instead, with no API key:{' '}
        <Link component={RouterLink} to="/settings/search">
          Semantic search on this device
        </Link>
        .
      </Typography>

      <Typography variant="body2" color="text.secondary">
        {hosts.length > 0 ? `Besides this device, KVox may connect only to: ${hosts.join(', ')}.` : 'KVox connects to nothing outside this device.'}
      </Typography>
    </Stack>
  );
}

// =============================================================================
// The parts
// =============================================================================

/** One provider as a full-width card with radio semantics; its accessible name is the label. */
function ProviderOption({
  id,
  label,
  description,
  checked,
  status,
}: {
  id: ProviderId;
  label: string;
  description: string;
  checked: boolean;
  status: 'ready' | 'setup' | null;
}) {
  const descriptionId = `ai-provider-${id}-description`;
  const statusId = `ai-provider-${id}-status`;
  return (
    <FormControlLabel
      value={id}
      control={
        <Radio
          sx={{ p: 0.5, mr: 1.5 }}
          slotProps={{ input: { 'aria-label': label, 'aria-describedby': status ? `${descriptionId} ${statusId}` : descriptionId } }}
        />
      }
      label={
        <Stack spacing={0.25}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" component="span" sx={{ fontWeight: 600, lineHeight: 1.4 }}>
              {label}
            </Typography>
            {status && (
              <Chip
                id={statusId}
                size="small"
                color={status === 'ready' ? 'success' : 'warning'}
                variant="outlined"
                label={status === 'ready' ? 'Ready' : 'Needs setup'}
              />
            )}
          </Stack>
          <Typography id={descriptionId} variant="body2" color="text.secondary">
            {description}
          </Typography>
        </Stack>
      }
      sx={{
        m: 0,
        width: '100%',
        alignItems: 'flex-start',
        px: 2,
        py: 1.5,
        borderRadius: 2,
        border: 1,
        borderColor: checked ? 'primary.main' : 'divider',
        bgcolor: checked ? 'action.selected' : 'transparent',
        transition: 'border-color 120ms, background-color 120ms',
        '&:hover': { bgcolor: checked ? 'action.selected' : 'action.hover' },
        '&:has(input:focus-visible)': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        '& .MuiFormControlLabel-label': { flex: 1, minWidth: 0 },
      }}
    />
  );
}

/** A small save button with its own status line (the setup forms). */
function useSave(onSave: () => Promise<void>, success: string) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const save = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await onSave();
      setOutcome({ severity: 'success', text: success });
    } catch (error) {
      setOutcome({ severity: 'error', text: message(error) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, outcome, save, clear: () => setOutcome(null) };
}

/** OpenAI's model, saved on its own. */
function ModelSetting({ saved, onSave }: { saved: string; onSave: (model: string) => Promise<void> }) {
  const [draft, setDraft] = useState(saved);
  // The stored value wins once saved (the server may normalise it).
  useEffect(() => setDraft(saved), [saved]);
  const model = draft.trim();
  const { busy, outcome, save, clear } = useSave(() => onSave(model), 'Model saved.');
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField
          label="Model"
          size="small"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            clear();
          }}
          helperText="The OpenAI model notes and Ask use."
          sx={{ flex: '1 1 240px', maxWidth: 360 }}
        />
        <Button variant="outlined" onClick={() => void save()} disabled={busy || model === '' || model === saved} sx={{ mt: '2px' }}>
          Save model
        </Button>
      </Stack>
      <OutcomeLine outcome={outcome} />
    </Stack>
  );
}

/** The compatible server's address, model, wire style and whether it needs a key. */
function CompatibleServerSettings({ saved, onSave }: { saved: CompatibleSettings; onSave: (next: CompatibleSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<CompatibleSettings>(saved);
  // The stored values win once saved (the server drops a trailing slash from the URL); keyed on the value.
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [savedKey]);
  const changed = (Object.keys(draft) as Array<keyof CompatibleSettings>).some((field) => draft[field] !== saved[field]);
  const { busy, outcome, save, clear } = useSave(() => onSave(draft), 'Server settings saved.');
  const edit = (patch: Partial<CompatibleSettings>) => {
    setDraft({ ...draft, ...patch });
    clear();
  };
  return (
    <Stack spacing={2}>
      <TextField
        label="Base URL"
        size="small"
        placeholder="http://127.0.0.1:11434/v1"
        value={draft.baseUrl ?? ''}
        onChange={(event) => edit({ baseUrl: event.target.value.trim() || null })}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="Model"
          size="small"
          value={draft.model ?? ''}
          onChange={(event) => edit({ model: event.target.value.trim() || null })}
          sx={{ flex: 1 }}
        />
        <TextField
          select
          label="API style"
          size="small"
          value={draft.apiStyle}
          onChange={(event) => edit({ apiStyle: event.target.value as CompatibleSettings['apiStyle'] })}
          sx={{ flex: 1 }}
        >
          <MenuItem value="chat_completions">Chat Completions</MenuItem>
          <MenuItem value="responses">Responses</MenuItem>
        </TextField>
      </Stack>
      <FormControlLabel
        control={<Checkbox checked={draft.requiresKey} onChange={(event) => edit({ requiresKey: event.target.checked })} />}
        label="The server needs an API key"
        sx={{ alignSelf: 'flex-start' }}
      />
      <Box>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !changed}>
          Save server settings
        </Button>
      </Box>
      <OutcomeLine outcome={outcome} />
    </Stack>
  );
}
