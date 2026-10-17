import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTES_NOTIFICATION_EVENTS } from '@marinoscar/kvox-api/notes';

import { DesktopNotify, type DesktopNotification } from '../../src/server/ports/desktop-notify';
import { JsonlAudit } from '../../src/server/ports/jsonl-audit';

// KVOX_NOTIFY shows a heading and a fixed line, never note content; KVOX_AUDIT
// appends ids and counts only (marinoscar/kvox#583).

describe('DesktopNotify', () => {
  it("shows the notes slice's heading and a fixed line, never the note's title", () => {
    const shown: DesktopNotification[] = [];
    const notify = new DesktopNotify({ show: (n) => shown.push(n), appName: 'KVox Desktop' });
    notify.registerEvents([...NOTES_NOTIFICATION_EVENTS]);
    notify.notify(NOTES_NOTIFICATION_EVENTS[0].key, 'user-1', { noteId: 'n1', title: 'Secret merger plan', templateName: 'General', wordCount: 300 });
    expect(shown).toEqual([{ title: 'Note ready', body: 'Open KVox Desktop to see it.' }]);
    expect(JSON.stringify(shown)).not.toContain('Secret merger plan');
  });

  it('never throws: an unknown event, or a template that throws, shows nothing', () => {
    const shown: DesktopNotification[] = [];
    const notify = new DesktopNotify({ show: (n) => shown.push(n), appName: 'KVox Desktop' });
    notify.registerEvents([{ key: 'x.broken', label: 'Broken', description: '', channels: ['browser'], browserTemplate: () => { throw new Error('bad'); } }]);
    expect(notify.notify('x.unknown', 'u', {})).toBeUndefined();
    expect(notify.notify('x.broken', 'u', {})).toBeUndefined();
    expect(shown).toEqual([]);
  });
});

describe('JsonlAudit', () => {
  it('appends one line per event, keeping ids and counts and dropping any other text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kvox-audit-')), 'logs', 'audit.log');
    const audit = new JsonlAudit(file);
    const noteId = '7d7f0c38-3d8f-4a83-9a5b-0c1a1d7d9e10';
    await Promise.all([
      audit.record({ actorUserId: 'u-1', action: 'note.deleted', targetType: 'note', targetId: noteId, meta: { title: 'Secret plan', words: 12, pinned: true, sourceId: noteId } }),
      audit.record({ actorUserId: null, action: 'job.failed', targetType: 'job', targetId: 'j-1' }),
    ]);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ action: 'note.deleted', targetId: noteId, meta: { words: 12, pinned: true, sourceId: noteId } });
    expect(JSON.stringify(lines)).not.toContain('Secret plan');
    await audit.record({ actorUserId: 'u-1', action: 'third', targetType: 't', targetId: '3' });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
