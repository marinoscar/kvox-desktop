import { UserNoteTemplatesPage } from '@marinoscar/kvox-web/notes/ui';

import { desktopNotesAiAccess } from '../notesAi';

/** The notes slice's templates page, given Desktop's AI access (the page's "add your key" state links to Settings). */
export function NoteTemplatesPage() {
  return <UserNoteTemplatesPage ai={desktopNotesAiAccess} />;
}
