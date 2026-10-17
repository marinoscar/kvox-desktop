import type { ReactElement } from 'react';
import { Navigate, Route } from 'react-router-dom';

import { useHasPermission } from '@marinoscar/kvox-web/core/headless';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';
import { NewNotePage, NotePage, UserNoteTemplatesPage, kvoxNotesRoutes } from '@marinoscar/kvox-web/notes/ui';

import { desktopNotesAiAccess } from './notesAi';

// =============================================================================
// Routes: the slices' route data, rendered with the host's own guard
// =============================================================================
//
// The pages that take an `ai` prop are wrapped (the web edition's
// apps/web/src/kvox/notesRoutes.ts does the same); paths, permissions and
// order are the slice's.
// =============================================================================

const NewNotePageWithAi = () => <NewNotePage ai={desktopNotesAiAccess} />;
const NotePageWithAi = () => <NotePage ai={desktopNotesAiAccess} />;
const UserNoteTemplatesPageWithAi = () => <UserNoteTemplatesPage ai={desktopNotesAiAccess} />;

export const desktopNotesRoutes: readonly KvoxRouteDef[] = kvoxNotesRoutes.map((route) => {
  if (route.path === '/notes/new') return { ...route, Component: NewNotePageWithAi };
  if (route.path === '/notes/:id') return { ...route, Component: NotePageWithAi };
  if (route.path === '/settings/note-templates') return { ...route, Component: UserNoteTemplatesPageWithAi };
  return route;
});

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
