import type { ReactElement } from 'react';
import { Navigate, Route } from 'react-router-dom';

import { AskEntityButtonSlot, AskEntityPanelSlot, kvoxAskRoutes } from '@marinoscar/kvox-web/ask/ui';
import { useHasPermission } from '@marinoscar/kvox-web/core/headless';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';
import { GraphEntityPage, graphNotePageSlots, graphNotesLibrarySlots, kvoxGraphRoutes } from '@marinoscar/kvox-web/graph/ui';
import type { GraphEntityPageSlots } from '@marinoscar/kvox-web/graph/ui';
import { NewNotePage, NotePage, NotesPage, UserNoteTemplatesPage, kvoxNotesRoutes } from '@marinoscar/kvox-web/notes/ui';

import { ImportButton } from './import/ImportProvider';
import { desktopNotesAiAccess } from './notesAi';

// =============================================================================
// Routes: the slices' route data, rendered with the host's own guard
// =============================================================================
//
// The pages that take an `ai` prop or slots are wrapped (the web edition's
// apps/web/src/kvox/notesRoutes.ts and graphRoutes.ts do the same), and the
// library gets the "Import…" action beside "New note" (marinoscar/kvox#585);
// paths, permissions and order are the slices'. The slots are the slices' own
// ready-made fillers (marinoscar/kvox#586):
//
//   note page       graphNotePageSlots: the review sheet over the note's
//                   proposal, "Add to graph" on a selection, the extract dialog
//   notes library   graphNotesLibrarySlots: entity hits above search results
//   entity page     the ask slice's Ask action and panel
// =============================================================================

const NotesPageWithImport = () => <NotesPage secondaryAction={<ImportButton />} slots={graphNotesLibrarySlots} />;
const NewNotePageWithAi = () => <NewNotePage ai={desktopNotesAiAccess} />;
const NotePageWithSlots = () => <NotePage ai={desktopNotesAiAccess} slots={graphNotePageSlots} />;
const UserNoteTemplatesPageWithAi = () => <UserNoteTemplatesPage ai={desktopNotesAiAccess} />;
const entitySlots: GraphEntityPageSlots = { AskButton: AskEntityButtonSlot, AskPanel: AskEntityPanelSlot };
const GraphEntityPageWithAsk = () => <GraphEntityPage slots={entitySlots} />;

export const desktopNotesRoutes: readonly KvoxRouteDef[] = kvoxNotesRoutes.map((route) => {
  if (route.path === '/notes') return { ...route, Component: NotesPageWithImport };
  if (route.path === '/notes/new') return { ...route, Component: NewNotePageWithAi };
  if (route.path === '/notes/:id') return { ...route, Component: NotePageWithSlots };
  if (route.path === '/settings/note-templates') return { ...route, Component: UserNoteTemplatesPageWithAi };
  return route;
});

/** The graph routes (Knowledge, the explorer, the overview, Review, imports) and Ask's. */
export const desktopKnowledgeRoutes: readonly KvoxRouteDef[] = [
  ...kvoxGraphRoutes.map((route) => (route.path === '/graph/entities/:id' ? { ...route, Component: GraphEntityPageWithAsk } : route)),
  ...kvoxAskRoutes,
];

function Gate({ permission, redirectTo, children }: { permission?: string; redirectTo?: string; children: ReactElement }) {
  const allowed = useHasPermission(permission ?? '');
  return permission === undefined || allowed ? children : <Navigate to={redirectTo ?? '/'} replace />;
}

/** The `<Route>` elements of a slice's route data. */
export function renderKvoxRoutes(routes: readonly KvoxRouteDef[]) {
  return routes.map(({ path, permission, redirectTo, Component }) => (
    <Route
      key={path}
      path={path}
      element={
        <Gate permission={permission} redirectTo={redirectTo}>
          <Component />
        </Gate>
      }
    />
  ));
}
