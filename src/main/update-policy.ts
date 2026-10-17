// =============================================================================
// What the updater may reach, and when (marinoscar/kvox#587, ADR-0004)
// =============================================================================
//
// Updates are OFF until the user turns on "Check for updates". Off, the
// updater is never loaded and its session reaches nothing. On, its session
// reaches GitHub Releases only: the release feed, the `latest*.yml` files and
// the installers (served from GitHub's release-asset hosts after a redirect).
// No user data is sent: these are plain GETs of public files.
//
// Pure functions, no Electron: the unit tests import them as they are.
// =============================================================================

/** The repository the releases come from (electron-builder.yml `publish`). */
export const UPDATE_REPOSITORY = { owner: 'marinoscar', repo: 'kvox-desktop' } as const;

/** The hosts the updater reaches when updates are on. */
export const UPDATE_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/** True for a loopback name or address. */
function isLoopbackHost(hostname: string): boolean {
  const name = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** The hosts the updater's session may reach in this state. */
export function allowedUpdateHosts(enabled: boolean): readonly string[] {
  return enabled ? UPDATE_HOSTS : [];
}

/**
 * Whether the updater's session may make this request. Off: nothing at all.
 * On: HTTPS to {@link UPDATE_HOSTS}, and a loopback feed (the e2e tests').
 */
export function updateRequestAllowed(url: string, enabled: boolean): boolean {
  if (!enabled) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isLoopbackHost(parsed.hostname)) return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  return parsed.protocol === 'https:' && UPDATE_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * The e2e tests' update feed (`KVOX_UPDATE_FEED_URL`), honoured only when it is
 * a loopback URL: it can never point the app at another server.
 */
export function testFeedUrl(env: Record<string, string | undefined>): string | null {
  const value = env.KVOX_UPDATE_FEED_URL;
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname) ? value : null;
  } catch {
    return null;
  }
}
