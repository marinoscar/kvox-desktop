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
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useKvoxHost } from '@marinoscar/kvox-web/core/headless';

// =============================================================================
// "AI provider": which provider runs the AI calls, its model and its key
// =============================================================================
//
// Reads and writes `/api/desktop/ai/settings` (non-secret settings) and
// `/api/desktop/ai/keys/:provider` (the key, stored by the server in the OS
// keychain through KVOX_SECRETS). The key field is write-only: the server
// answers a status (saved or not, the last four characters, when), never the key,
// and the field is cleared once it is saved. The GitHub Copilot slot is shown
// disabled until its adapter exists (marinoscar/kvox#581). Changing the
// provider changes the one host the app may reach, shown below the form
// (marinoscar/kvox#584).
// =============================================================================

type ProviderId = 'openai' | 'openai-compatible';

interface AiSettings {
  provider: ProviderId | null;
  openai: { model: string };
  openaiCompatible: { baseUrl: string | null; model: string | null; apiStyle: 'chat_completions' | 'responses'; requiresKey: boolean };
  copilot: { enabled: false };
}

interface KeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

interface SettingsView {
  settings: AiSettings;
  providers: Array<{ id: string; label: string; implemented: boolean; toolCalling: boolean; note: string; needsKey: boolean; key: KeyStatus | null }>;
  allowedHosts: string[];
}

type Outcome = { severity: 'success' | 'error'; text: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function AiProviderCard() {
  const host = useKvoxHost();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

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
  const copilot = view.providers.find((provider) => provider.id === 'copilot');
  const compatible = draft.openaiCompatible;
  const keyNeeded = active === 'openai' || (active === 'openai-compatible' && compatible.requiresKey);
  const savedKey = slot?.key ?? null;

  const saveSettings = () =>
    run(async () => {
      const next = await host.http.request<SettingsView>('PATCH', '/desktop/ai/settings', { body: draft });
      setView(next);
      setDraft(next.settings);
    }, 'AI settings saved.');

  const saveKey = () =>
    run(async () => {
      if (!active) return;
      await host.http.request<KeyStatus>('PUT', `/desktop/ai/keys/${active}`, { body: { apiKey } });
      setApiKey('');
      await load();
    }, 'API key saved in the system keychain.');

  const removeKey = () =>
    run(async () => {
      if (!active) return;
      await host.http.request<KeyStatus>('DELETE', `/desktop/ai/keys/${active}`);
      await load();
    }, 'API key removed.');

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
            .filter((provider) => provider.implemented)
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

      {keyNeeded && view.settings.provider === active && (
        <Stack spacing={1}>
          <Typography variant="body2" role="status" aria-label="API key status">
            {savedKey?.configured
              ? `A key is saved${savedKey.hint ? ` (${savedKey.hint})` : ''}${savedKey.updatedAt ? `, updated ${new Date(savedKey.updatedAt).toLocaleString()}` : ''}.`
              : 'No API key is saved.'}
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              label="API key"
              type="password"
              size="small"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              sx={{ flexGrow: 1 }}
            />
            <Button variant="outlined" onClick={() => void saveKey()} disabled={busy || apiKey === ''}>
              Save key
            </Button>
            <Button color="warning" onClick={() => void removeKey()} disabled={busy || !savedKey?.configured}>
              Remove key
            </Button>
          </Stack>
        </Stack>
      )}

      {copilot && (
        <Stack spacing={0.5}>
          <FormControlLabel control={<Switch checked={false} disabled />} label={`${copilot.label} (opt-in)`} />
          <Typography variant="caption" color="text.secondary">
            {copilot.note}
          </Typography>
        </Stack>
      )}

      <Typography variant="body2" color="text.secondary">
        {view.allowedHosts.length > 0
          ? `Besides this device, KVox may connect only to: ${view.allowedHosts.join(', ')}.`
          : 'KVox connects to nothing outside this device.'}
      </Typography>
      {outcome && (
        <Alert severity={outcome.severity} role={outcome.severity === 'error' ? 'alert' : 'status'}>
          {outcome.text}
        </Alert>
      )}
    </Stack>
  );
}
