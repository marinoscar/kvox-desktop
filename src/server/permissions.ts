import { GRAPH_PERMISSIONS } from '@marinoscar/kvox-api/graph';
import { NOTES_PERMISSIONS, NOTE_TEMPLATES_PERMISSIONS } from '@marinoscar/kvox-api/notes';
import { TRANSCRIPTS_PERMISSIONS } from '@marinoscar/kvox-api/transcripts';

/**
 * Every permission the one local user holds: the sets the slices export as
 * data (the graph set, `graph:read` and `graph:write`, also covers Ask), plus
 * the two `system_settings` strings of the transcription admin routes. Built
 * the way the bare host builds its principal.
 */
export const LOCAL_USER_PERMISSIONS: readonly string[] = [
  ...TRANSCRIPTS_PERMISSIONS,
  ...NOTES_PERMISSIONS,
  ...NOTE_TEMPLATES_PERMISSIONS,
  ...GRAPH_PERMISSIONS,
  'system_settings:read',
  'system_settings:write',
].map((permission) => (typeof permission === 'string' ? permission : permission.id));
