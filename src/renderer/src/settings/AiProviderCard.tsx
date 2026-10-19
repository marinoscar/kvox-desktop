import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { KvoxApiError, useKvoxHost } from '@marinoscar/kvox-web/core/headless';
import type { AiProbeResult, UserAiKey } from '@marinoscar/platform-web/ai/headless';
import { KeylessProviderCard, UserAiKeyCard } from '@marinoscar/platform-web/ai/ui';

import { CopilotSection } from './CopilotSection';
import { allowedHostsOf } from './copilotPort';

// =============================================================================
// "AI provider": which provider runs the AI calls, its model and its key
// =============================================================================
//
// Reads and writes `/api/desktop/ai/settings` (non-secret settings) and
// `/api/desktop/ai/keys/:provider` (the key, stored by the server in the OS
// keychain through KVOX_SECRETS). The key block is the platform's own
// `UserAiKeyCard` (the card KVox web shows: Save & verify, Test, Re-check,
// Remove) or, for a keyless server, its `KeylessProviderCard`; this file only
// binds them to the server (marinoscar/kvox-desktop#19). The key field is
// write-only: the server answers a status (saved or not, the last four
// characters, when), never the key, and the card clears the field once it is
// saved. Testing a key is `POST /api/desktop/ai/keys/:provider/test`, answered
// by the server through the adapter's `verifyKey`. The GitHub Copilot slot is
// an opt-in add-on below the form, the packaged `CopilotProviderCard`
// (`CopilotSection.tsx`, marinoscar/kvox-desktop#22). Changing the provider
// changes the one host the app may reach, shown below the form; with Copilot on,
// the Copilot card's footer lists every host instead (marinoscar/kvox#584).
// =============================================================================

type ProviderId = 'openai' | 'openai-compatible';

interface AiSettings {
  provider: ProviderId | null;
  openai: { model: string };
  openaiCompatible: { baseUrl: string | null; model: string | null; apiStyle: 'chat_completions' | 'responses'; requiresKey: boolean };
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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function AiProviderCard() {
  const host = useKvoxHost();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [checks, setChecks] = useState<Record<string, KeyCheck>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copilotStatus, setCopilotStatus] = useState<CopilotStatus | null>(null);
  // Saving the provider changes the hosts the server allows: the Copilot card reads its status again.
  const [copilotReads, setCopilotReads] = useState(0);

  const load = useCallback(async () => {
    const next = await host.http.request<SettingsView>('GET', '/desktop/ai/settings');
    setView(next);
    setDraft(next.settings);
  }, [host]);

  useEffect(() => {
    load().catch((error: unknown) => setOutcome({ severity: 'error', text: message(error) }));
  }, [load]);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setOutcome(null);
    try {
      await action();
      setOutcome({ severity: 'success', text: success });
    } catch (error) {
      setOutcome({ severity: 'error', text: message(error) });
    } finally {
      setBusy(false);
    }
  };

  if (!view || !draft) return <Typography variant="body2">Loading…</Typography>;

  const active = draft.provider;
  const slot = view.providers.find((provider) => provider.id === active);
  const compatible = draft.openaiCompatible;
  const keyNeeded = active === 'openai' || (active === 'openai-compatible' && compatible.requiresKey);
  const savedKey = slot?.key ?? null;
  const saved = active !== null && view.settings.provider === active;
  // The server's answer to the Copilot status is the freshest list (switching Copilot on or off changes it).
  const hosts = copilotStatus ? allowedHostsOf(copilotStatus) : view.allowedHosts;

  const saveSettings = () =>
    run(async () => {
      const next = await host.http.request<SettingsView>('PATCH', '/desktop/ai/settings', { body: draft });
      setView(next);
      setDraft(next.settings);
      setCopilotReads((reads) => reads + 1);
    }, 'AI settings saved.');

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

  // Save & verify: the provider must not reject the key (then nothing is stored). Any other
  // failure (offline, a gateway with no model list) still saves it and says it is unverified.
  const saveKey = async (provider: string, typedKey: string) => {
    const probe = await host.http.request<AiProbeResult>('POST', `/desktop/ai/keys/${provider}/test`, { body: { apiKey: typedKey } });
    const failure = probe.checks.find((check) => check.status === 'failed');
    if (failure?.code === 'AI_KEY_INVALID') throw new KvoxApiError('The provider rejected this key.', 400, 'BAD_REQUEST', { reason: 'AI_KEY_INVALID' });
    const status = await host.http.request<KeyStatus>('PUT', `/desktop/ai/keys/${provider}`, { body: { apiKey: typedKey } });
    remember(provider, probe);
    await load();
    if (failure) throw new Error(`The key was saved, but it could not be verified: ${failure.detail || 'the provider did not answer.'}`);
    return keyView(provider, status);
  };

  const removeKey = async (provider: string) => {
    await host.http.request<KeyStatus>('DELETE', `/desktop/ai/keys/${provider}`);
    setChecks(({ [provider]: _removed, ...rest }) => rest);
    await load();
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

  return (
    <Stack spacing={2}>
      <FormControl>
        <FormLabel id="ai-provider-label">Provider</FormLabel>
        <RadioGroup
          aria-labelledby="ai-provider-label"
          value={active ?? 'off'}
          onChange={(event) => setDraft({ ...draft, provider: event.target.value === 'off' ? null : (event.target.value as ProviderId) })}
        >
          {view.providers
            // An add-on (Copilot) is not a choice of THE provider: it has its own switch.
            .filter((provider) => provider.implemented && provider.primary)
            .map((provider) => (
              <FormControlLabel key={provider.id} value={provider.id} control={<Radio />} label={provider.label} />
            ))}
          <FormControlLabel value="off" control={<Radio />} label="Off (no AI features)" />
        </RadioGroup>
        {slot && <FormHelperText>{slot.note}</FormHelperText>}
      </FormControl>

      {active === 'openai' && (
        <TextField
          label="Model"
          size="small"
          value={draft.openai.model}
          onChange={(event) => setDraft({ ...draft, openai: { model: event.target.value } })}
        />
      )}

      {active === 'openai-compatible' && (
        <Stack spacing={2}>
          <TextField
            label="Base URL"
            size="small"
            placeholder="http://127.0.0.1:11434/v1"
            value={compatible.baseUrl ?? ''}
            onChange={(event) => setDraft({ ...draft, openaiCompatible: { ...compatible, baseUrl: event.target.value.trim() || null } })}
          />
          <TextField
            label="Model"
            size="small"
            value={compatible.model ?? ''}
            onChange={(event) => setDraft({ ...draft, openaiCompatible: { ...compatible, model: event.target.value.trim() || null } })}
          />
          <TextField
            select
            label="API style"
            size="small"
            value={compatible.apiStyle}
            onChange={(event) =>
              setDraft({ ...draft, openaiCompatible: { ...compatible, apiStyle: event.target.value as AiSettings['openaiCompatible']['apiStyle'] } })
            }
          >
            <MenuItem value="chat_completions">Chat Completions</MenuItem>
            <MenuItem value="responses">Responses</MenuItem>
          </TextField>
          <FormControlLabel
            control={
              <Checkbox
                checked={compatible.requiresKey}
                onChange={(event) => setDraft({ ...draft, openaiCompatible: { ...compatible, requiresKey: event.target.checked } })}
              />
            }
            label="The server needs an API key"
          />
        </Stack>
      )}

      <Stack direction="row" spacing={1}>
        <Button variant="contained" onClick={() => void saveSettings()} disabled={busy}>
          Save AI settings
        </Button>
      </Stack>

      {/* The key: only for the saved provider, so the card never tests a host the egress guard has not been told about. */}
      {saved && slot && keyNeeded && (
        <UserAiKeyCard
          provider={{ id: slot.id, displayName: slot.label, hasOrgKey: false }}
          keyView={keyView(slot.id, savedKey ?? { configured: false, hint: null, updatedAt: null })}
          orgFallback={false}
          onSave={saveKey}
          onTest={testKey}
          onRemove={removeKey}
        />
      )}
      {saved && slot && active === 'openai-compatible' && !keyNeeded && (
        <KeylessProviderCard provider={{ id: slot.id, displayName: slot.label }} />
      )}

      {/* The add-on: its own card, consent and sign-in. Its status keeps the footer below true. */}
      <CopilotSection key={copilotReads} onStatus={setCopilotStatus} />

      {/* With Copilot on, the card's own footer lists every allowed host, so this one steps aside. */}
      {copilotStatus?.enabled !== true && (
        <Typography variant="body2" color="text.secondary">
          {hosts.length > 0
            ? `Besides this device, KVox may connect only to: ${hosts.join(', ')}.`
            : 'KVox connects to nothing outside this device.'}
        </Typography>
      )}
      {outcome && (
        <Alert severity={outcome.severity} role={outcome.severity === 'error' ? 'alert' : 'status'}>
          {outcome.text}
        </Alert>
      )}
    </Stack>
  );
}
