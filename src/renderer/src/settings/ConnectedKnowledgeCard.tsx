import { useState } from 'react';
import Alert from '@mui/material/Alert';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import { useDesktopKnowledge } from '../knowledge';

// =============================================================================
// "Connected knowledge": the `ai.graphEnabled` switch (marinoscar/kvox#620)
// =============================================================================
//
// On by default. Off, KVox makes no graph AI call (extraction, resolution,
// entity briefs, Ask), hides Knowledge, Review and Ask, and keeps the graph
// already built; on again, it all comes back. The switch follows the server's
// answer, so a failed write leaves it where it was.
// =============================================================================

export function ConnectedKnowledgeCard() {
  const { graphEnabled, setGraphEnabled } = useDesktopKnowledge();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await setGraphEnabled(enabled);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2">
        When on, KVox reads your notes into a knowledge graph of people, organizations, projects and what was decided, and
        answers questions about it in Ask. Each extraction, entity brief and answer is a call to your AI provider.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={graphEnabled === true}
            disabled={graphEnabled === undefined || saving}
            onChange={(event) => void toggle(event.target.checked)}
          />
        }
        label="Connected knowledge"
      />
      {graphEnabled === false && (
        <Alert severity="info" role="status">
          Connected knowledge is off: KVox makes no graph or Ask calls to your AI provider, and Knowledge, Review and Ask are hidden.
          The graph you already have is kept.
        </Alert>
      )}
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}
