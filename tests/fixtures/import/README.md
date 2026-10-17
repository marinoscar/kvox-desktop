# Import fixtures (synthetic)

Every file here is made up; none comes from a real meeting.

| File | What it is | Imports as |
|---|---|---|
| `roadmap-sync-transcript.pdf` | A transcript as a PDF, written with `pdfkit` | A note source document (`POST /api/notes/sources/documents`) |
| `m03-roadmap-sync.transcript.json` | A `kvox.transcript/v1` export: three speakers (two named), `recordedAt` | A transcript (`POST /api/transcripts/imports`) |
| `planning-sync-note.md` | A note exported from KVox web: written by the package's own `MarkdownNoteExporter` | A note (`POST /api/notes/import`) |
| `planning-sync-note.expected.json` | The title and body that note must import to | (the round-trip assertion) |
| `standup.md` | Plain Markdown | A note source document |
| `foreign.json` | JSON that is not a KVox export | Refused by the transcript import (`unsupported_schema`) |
