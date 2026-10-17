import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { KvoxAuditEvent, KvoxAuditPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// JsonlAudit: KVOX_AUDIT as append-only JSON lines (marinoscar/kvox#583)
// =============================================================================
//
// One line per event in `<userData>/logs/audit.log`, opened in append mode
// only (never rewritten, never truncated), lines written one after another so
// two events never interleave.
//
// IDS AND COUNTS ONLY. A line keeps who (`actorUserId`), what (`action`), on
// what (`targetType`, `targetId`) and when; of `meta` it keeps numbers,
// booleans and values that are ids (UUIDs). Any other string (a title, a file
// name, an error text) is dropped, so the log never holds content.
// =============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `meta` values an audit line may hold: numbers, booleans and ids. */
export function idsAndCounts(meta: Record<string, unknown> | undefined): Record<string, number | boolean | string> {
  const kept: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') kept[key] = value;
    else if (typeof value === 'string' && UUID.test(value)) kept[key] = value;
  }
  return kept;
}

/** KVOX_AUDIT over an append-only file. */
export class JsonlAudit implements KvoxAuditPort {
  private chain: Promise<void> = Promise.resolve();

  /** @param file - `<userData>/logs/audit.log`. */
  constructor(private readonly file: string) {}

  record(event: KvoxAuditEvent): Promise<void> {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      meta: idsAndCounts(event.meta),
    });
    const write = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${line}\n`, { flag: 'a', mode: 0o600 });
    });
    this.chain = write.catch(() => undefined);
    return write;
  }
}
