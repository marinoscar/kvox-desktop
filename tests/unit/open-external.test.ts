import { describe, expect, it, vi } from 'vitest';

import { openExternalChecked, parseExternalUrl } from '../../src/main/open-external';

// =============================================================================
// The "open in the browser" allowlist (marinoscar/kvox-desktop#22)
// =============================================================================
// Only https://github.com/... may leave the window; every other address is refused.
// =============================================================================

describe('parseExternalUrl', () => {
  it.each([
    ['https://github.com/login/device', 'https://github.com/login/device'],
    ['https://github.com/', 'https://github.com/'],
    ['https://github.com', 'https://github.com/'],
    ['https://GITHUB.com/login/device?code=A', 'https://github.com/login/device?code=A'],
    ['https://github.com/site/terms#section', 'https://github.com/site/terms#section'],
    ['https://github.com:443/login/device', 'https://github.com/login/device'],
  ])('allows %s', (input, expected) => {
    expect(parseExternalUrl(input)).toBe(expected);
  });

  it.each([
    'http://github.com/login/device',
    'https://github.com.evil.com/login/device',
    'https://evilgithub.com/',
    'https://notgithub.com/',
    'https://www.github.com/',
    'https://api.github.com/',
    'https://githubcom/',
    'https://github.com@evil.com/',
    'https://user:pass@github.com/',
    'https://user@github.com/',
    'https://github.com:8443/',
    'https://evil.com/?https://github.com/',
    'https://evil.com#@github.com',
    'https://github.com%2eevil.com/',
    'https://github.com。evil.com/',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)//github.com',
    'file:///etc/passwd',
    'file://github.com/etc/passwd',
    'data:text/html,<script>1</script>',
    'ftp://github.com/',
    'mailto:a@github.com',
    '//github.com/',
    '/login/device',
    'github.com/login',
    '',
    ' ',
    'not a url',
  ])('refuses %j', (input) => {
    expect(parseExternalUrl(input)).toBeNull();
  });

  it('refuses a backslash trick that would move the host', () => {
    // WHATWG parsing reads the backslash as a slash: the host is evil.com here.
    expect(parseExternalUrl('https://evil.com\\@github.com/')).toBeNull();
  });

  it.each([undefined, null, 42, {}, [], ['https://github.com/'], true])('refuses the non-string %j', (input) => {
    expect(parseExternalUrl(input)).toBeNull();
  });

  it('refuses an oversized address', () => {
    expect(parseExternalUrl(`https://github.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('openExternalChecked', () => {
  it('opens an allowed address, normalized', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await expect(openExternalChecked('https://GitHub.com/login/device', open)).resolves.toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device');
  });

  it('never calls the opener for a refused address', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await expect(openExternalChecked('https://github.com.evil.com/', open)).resolves.toBe(false);
    await expect(openExternalChecked('javascript:alert(1)', open)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
