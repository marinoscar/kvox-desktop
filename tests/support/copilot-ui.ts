import { COPILOT_CONSENT_COPY } from '@marinoscar/kvox-web/copilot/headless';

// =============================================================================
// The words of the packaged Copilot card, for the e2e specs (marinoscar/kvox-desktop#22)
// =============================================================================
//
// The card's text is the package's, written once (`COPILOT_CONSENT_COPY`); the
// specs read it from there so a rewording in the package does not break them.
// The other labels are the card's and the platform's accessible names
// (`AccountSignInProviderCard`: "Enable {name}", "Sign in with {name}", "Sign out").
// =============================================================================

export const COPILOT_CONSENT_TITLE = COPILOT_CONSENT_COPY.title;
export const COPILOT_ACCEPT_LABEL = COPILOT_CONSENT_COPY.acceptLabel;
export const COPILOT_SWITCH = 'Enable GitHub Copilot';
export const COPILOT_SIGN_IN_BUTTON = 'Sign in with GitHub Copilot';
export const COPILOT_SIGN_IN_DIALOG = 'Sign in to GitHub Copilot';
export const COPILOT_DOWNLOAD_BUTTON = 'Download runtime';
