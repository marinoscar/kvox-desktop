import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import HubIcon from '@mui/icons-material/Hub';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import PrivacyTipIcon from '@mui/icons-material/PrivacyTip';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';

import { kvoxNotesUserSettingsSections } from '@marinoscar/kvox-web/notes/ui';
import type { SettingsSectionDef } from '@marinoscar/platform-web/settings/ui';

// =============================================================================
// The settings registry: one card per page of Settings (marinoscar/kvox-desktop#19)
// =============================================================================
//
// The same registry-driven hub as KVox web: `<SettingsHub sections=...>` of
// `@marinoscar/platform-web/settings/ui` draws it, and a card opens its own page
// (`routes.tsx` holds the route for each `path` here; `settings-hub.test.tsx`
// proves the two lists agree). A card with a page but no entry here, or the
// reverse, is a bug: the hub, the app-bar title and the rail would disagree.
//
// Append a new card at the END of its group (or a new group); never insert
// between existing cards. A card whose gate is a capability carries no
// `permission` (Desktop has one local user, so every card is visible); there is
// no `feature` either, so no card is hidden.
//
// "Note Templates" is the notes slice's own card (`kvoxNotesUserSettingsSections`),
// the one KVox web shows, so its title, description and icon are the package's.
// =============================================================================

/** The hub's `hubKey` (scroll restoration), title and subtitle. */
export const DESKTOP_SETTINGS_HUB_KEY = 'desktop-settings';
export const DESKTOP_SETTINGS_TITLE = 'Settings';
export const DESKTOP_SETTINGS_SUBTITLE = 'The AI provider, your notes, and how KVox keeps your data on this device.';
/** The hub's route. */
export const DESKTOP_SETTINGS_PATH = '/settings';

const [noteTemplatesCard] = kvoxNotesUserSettingsSections.account;
if (!noteTemplatesCard) throw new Error('The notes slice declares no Note Templates settings card');

export const DESKTOP_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'AI and notes',
    cards: [
      {
        title: 'AI provider',
        description: 'Choose the provider that writes your notes, its model, and save and test its key.',
        Icon: AutoAwesomeIcon,
        path: '/settings/ai',
      },
      {
        title: 'Connected knowledge',
        description: 'Build a graph of the people, projects and decisions in your notes. Switch it off at any time.',
        Icon: HubIcon,
        path: '/settings/knowledge',
      },
      noteTemplatesCard,
      {
        title: 'Semantic search on this device',
        description: 'Find notes and transcripts by meaning, on this computer: no API key, works offline. A one-time model download.',
        Icon: ManageSearchIcon,
        path: '/settings/search',
      },
    ],
  },
  {
    label: 'This device',
    cards: [
      {
        title: 'Data and privacy',
        description: 'Where your data lives, export and restore a backup, and how saved keys are protected.',
        Icon: PrivacyTipIcon,
        path: '/settings/data',
      },
      {
        title: 'Updates',
        description: 'Check for new versions of KVox. Off until you turn it on.',
        Icon: SystemUpdateAltIcon,
        path: '/settings/updates',
      },
    ],
  },
];
