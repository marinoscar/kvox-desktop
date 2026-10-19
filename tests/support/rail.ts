import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

// =============================================================================
// The shell's left rail in the e2e specs (marinoscar/kvox-desktop#18)
// =============================================================================
//
// The destinations are the rail's items, found by role and accessible name (the shell gives each link an
// `aria-label`), never by visible text: the collapsed rail shows icons only and the label's case is the
// shell's business. Windows in these specs are 1280 px wide, so the rail (not the phone bar) is on screen.
// =============================================================================

/**
 * Makes the window wide enough for the expanded rail tier (the platform's `lg`, 1200 px), where the collapse
 * button exists. The app asks for 1280 px, but a runner whose screen is smaller (the Windows CI display) clamps
 * it, and the medium tier has no collapse control. Resizing is the test's business, not the app's.
 */
export async function useWideWindow(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1400, 900);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1200);
}

/** The rail (`Main navigation`). */
export function rail(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main navigation' });
}

/** One destination of the rail: Notes, Knowledge, Review, Ask or Settings. */
export function railItem(page: Page, name: 'Notes' | 'Knowledge' | 'Review' | 'Ask' | 'Settings'): Locator {
  return rail(page).getByRole('link', { name, exact: true });
}

/** Clicks a destination, as a user does. */
export async function goTo(page: Page, name: Parameters<typeof railItem>[1]): Promise<void> {
  await railItem(page, name).click();
}

/** The destinations the rail lists now, in order. */
export async function railDestinations(page: Page): Promise<Array<string | null>> {
  return rail(page).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('aria-label')));
}

/** The avatar button of the user menu (it has no accessible name of its own). */
export function userMenuButton(page: Page): Locator {
  return page.locator('header button[aria-haspopup="true"]');
}

/** Waits for the rail to show exactly these destinations. */
export async function expectRail(page: Page, names: string[]): Promise<void> {
  await expect.poll(() => railDestinations(page)).toEqual(names);
}
