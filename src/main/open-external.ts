// =============================================================================
// Opening a link in the system browser (marinoscar/kvox-desktop#22)
// =============================================================================
//
// The GitHub Copilot card shows a device code and a link to github.com (and the
// terms). The window may not navigate or open pop-ups (`src/main/index.ts`), so
// the renderer asks the main process, which opens ONLY `https://github.com/...`:
// https, the exact host `github.com`, no credentials in the URL, no custom port.
// Everything else is refused (a lookalike host, `http:`, `javascript:`, `file:`,
// userinfo tricks). The normalized `href` is what gets opened, never the raw text.
// =============================================================================

const MAX_URL_LENGTH = 2048;

/** The URL to open for `value`, or `null` when it is not an `https://github.com/...` address. */
export function parseExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'github.com') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  return url.href;
}

/** Opens `value` through `open` when it is allowed; answers whether it did. */
export async function openExternalChecked(value: unknown, open: (url: string) => Promise<void>): Promise<boolean> {
  const url = parseExternalUrl(value);
  if (url === null) return false;
  await open(url);
  return true;
}
