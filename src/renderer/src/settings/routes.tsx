import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Route } from 'react-router-dom';

import { SettingsHub } from '@marinoscar/platform-web/settings/ui';

import { SettingsPageFrame } from './SettingsPageFrame';
import {
  DESKTOP_SETTINGS_HUB_KEY,
  DESKTOP_SETTINGS_PATH,
  DESKTOP_SETTINGS_SECTIONS,
  DESKTOP_SETTINGS_SUBTITLE,
  DESKTOP_SETTINGS_TITLE,
} from './sections';

// =============================================================================
// The settings routes: the hub, and one page per card of `sections.tsx`
// =============================================================================
//
// Every path here has a card in DESKTOP_SETTINGS_SECTIONS and every card has a
// route (tests/unit/settings-hub.test.tsx). The pages are lazy, so the hub
// loads none of them.
// =============================================================================

export interface DesktopSettingsRoute {
  path: string;
  Component: LazyExoticComponent<ComponentType> | ComponentType;
  /** The page draws its own `h1` (the notes slice's templates page does). */
  ownHeading?: boolean;
}

const AiProviderPage = lazy(() => import('./AiProviderCard').then((module) => ({ default: module.AiProviderCard })));
const ConnectedKnowledgePage = lazy(() => import('./ConnectedKnowledgeCard').then((module) => ({ default: module.ConnectedKnowledgeCard })));
const NoteTemplatesPage = lazy(() => import('./NoteTemplatesPage').then((module) => ({ default: module.NoteTemplatesPage })));
const DataPrivacyPage = lazy(() => import('./DataPrivacyCard').then((module) => ({ default: module.DataPrivacyCard })));
const UpdatesPage = lazy(() => import('./UpdatesCard').then((module) => ({ default: module.UpdatesCard })));

/** The page of each card. Append to the end, like the registry. */
export const desktopSettingsRoutes: readonly DesktopSettingsRoute[] = [
  { path: '/settings/ai', Component: AiProviderPage },
  { path: '/settings/knowledge', Component: ConnectedKnowledgePage },
  { path: '/settings/note-templates', Component: NoteTemplatesPage, ownHeading: true },
  { path: '/settings/data', Component: DataPrivacyPage },
  { path: '/settings/updates', Component: UpdatesPage },
];

/** `/settings`: the registry's hub. */
function DesktopSettingsHub() {
  return (
    <SettingsHub
      sections={DESKTOP_SETTINGS_SECTIONS}
      hubKey={DESKTOP_SETTINGS_HUB_KEY}
      title={DESKTOP_SETTINGS_TITLE}
      subtitle={DESKTOP_SETTINGS_SUBTITLE}
    />
  );
}

/** The `<Route>` elements of the hub and its pages (rendered inside the app's `<Routes>`). */
export function renderDesktopSettingsRoutes() {
  return [
    <Route key={DESKTOP_SETTINGS_PATH} path={DESKTOP_SETTINGS_PATH} element={<DesktopSettingsHub />} />,
    ...desktopSettingsRoutes.map(({ path, Component, ownHeading }) => (
      <Route
        key={path}
        path={path}
        element={
          <SettingsPageFrame ownHeading={ownHeading === true}>
            <Component />
          </SettingsPageFrame>
        }
      />
    )),
  ];
}
