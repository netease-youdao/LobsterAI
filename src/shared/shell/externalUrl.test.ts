import { describe, expect, test } from 'vitest';

import { OPEN_EXTERNAL_URL_MAX_LENGTH, openExternalSafe, OpenExternalUrlError } from './externalUrl';

describe('openExternalSafe', () => {
  test('allows http, https, mailto and tel', () => {
    expect(openExternalSafe('https://example.com/path?a=1')).toEqual({
      ok: true,
      url: 'https://example.com/path?a=1',
    });
    expect(openExternalSafe('http://example.com').ok).toBe(true);
    expect(openExternalSafe('mailto:test@example.com').ok).toBe(true);
    expect(openExternalSafe('tel:+861234567890').ok).toBe(true);
  });

  test('accepts case-insensitive protocols and surrounding whitespace', () => {
    expect(openExternalSafe('  HTTPS://EXAMPLE.COM  ')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
  });

  test.each([
    ['javascript:alert(1)', OpenExternalUrlError.UnsupportedProtocol],
    ['data:text/html,<script>alert(1)</script>', OpenExternalUrlError.UnsupportedProtocol],
    ['file:///etc/passwd', OpenExternalUrlError.UnsupportedProtocol],
    ['vbscript:msgbox(1)', OpenExternalUrlError.UnsupportedProtocol],
    ['example.com/path', OpenExternalUrlError.MissingScheme],
    ['//host/path', OpenExternalUrlError.MissingScheme],
    ['http://', OpenExternalUrlError.InvalidUrl],
    ['https://exa mple.com', OpenExternalUrlError.InvalidUrl],
    ['https://example.com\njavascript:alert(1)', OpenExternalUrlError.InvalidUrl],
  ])('rejects unsafe URL "%s"', (input, error) => {
    const result = openExternalSafe(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  test('rejects non-string, empty and overlong inputs', () => {
    expect(openExternalSafe(42 as unknown)).toMatchObject({
      ok: false,
      error: OpenExternalUrlError.NonString,
    });
    expect(openExternalSafe('   ')).toMatchObject({
      ok: false,
      error: OpenExternalUrlError.Empty,
    });
    expect(openExternalSafe(`https://example.com/${'x'.repeat(OPEN_EXTERNAL_URL_MAX_LENGTH)}`))
      .toMatchObject({
        ok: false,
        error: OpenExternalUrlError.TooLong,
      });
  });
});
