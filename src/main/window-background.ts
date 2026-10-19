import { kvoxTokens } from '@marinoscar/kvox-web/brand';

import type { ThemeMode } from '../shared/protocol';

// =============================================================================
// The colour behind the page (marinoscar/kvox-desktop#17)
// =============================================================================
//
// A BrowserWindow shows its `backgroundColor` until the page has painted its
// own; without one, a dark-mode user sees a white window for as long as the
// local server takes to start. The colours are the brand's page grounds, read
// from `kvoxTokens` of `@marinoscar/kvox-web/brand` (the same tokens the theme
// is built from): no hex value is written in this repository.
//
// `kvox-web` is a build-time dependency, bundled into the main process; the
// package is side-effect free, so only the token map is pulled in, not the
// theme or MUI.
// =============================================================================

/**
 * The page ground for `mode`.
 *
 * @param mode - the saved choice.
 * @param systemPrefersDark - `nativeTheme.shouldUseDarkColors`; read only for `system`.
 */
export function windowBackground(mode: ThemeMode, systemPrefersDark: boolean): string {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark);
  return (dark ? kvoxTokens.dark : kvoxTokens.light).background.default;
}
