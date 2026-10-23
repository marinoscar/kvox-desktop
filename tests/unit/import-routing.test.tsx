import { describe, expect, it } from 'vitest';

import { importTarget } from '../../src/renderer/src/import/ImportProvider';

// Where an import opens (marinoscar/kvox#585, marinoscar/kvox-desktop#47): note documents went into an import
// batch, whose progress page is the notes slice's own; a note export opens the note; a transcript opens
// "New note" with it chosen.
describe('importTarget', () => {
  it('opens the batch page for note documents, the note for an export, "New note" for a transcript', () => {
    expect(importTarget({ ok: true, kind: 'batch', id: 'b 1', title: '2 documents', filename: 'a.md' })).toBe('/notes/import-batches/b%201');
    expect(importTarget({ ok: true, kind: 'note', id: 'n1', title: 'Plan', filename: 'plan.md' })).toBe('/notes/n1');
    expect(importTarget({ ok: true, kind: 'transcript', id: 't1', title: 'Sync', filename: 's.json' })).toBe('/notes/new?transcriptId=t1');
  });
});
