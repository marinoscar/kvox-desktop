import type { ComponentType } from 'react';

import { AiProviderCard } from './AiProviderCard';
import { DataPrivacyCard } from './DataPrivacyCard';
import { UpdatesCard } from './UpdatesCard';

// =============================================================================
// The settings registry: one entry per card of the settings page
// =============================================================================
//
// D3 (marinoscar/kvox#584) adds "AI provider": the provider, its model and its
// key; D2 (marinoscar/kvox#583) adds "Data and privacy": the data folder,
// Export data / Restore, and how saved keys are protected; D6
// (marinoscar/kvox#587) adds "Updates", the opt-in "Check for updates". Order
// is the page's order.
// =============================================================================

export interface DesktopSettingsCard {
  /** A stable id (the card's anchor). */
  id: string;
  title: string;
  Component: ComponentType;
}

export const desktopSettingsCards: readonly DesktopSettingsCard[] = [
  { id: 'ai-provider', title: 'AI provider', Component: AiProviderCard },
  { id: 'data-privacy', title: 'Data and privacy', Component: DataPrivacyCard },
  { id: 'updates', title: 'Updates', Component: UpdatesCard },
];
