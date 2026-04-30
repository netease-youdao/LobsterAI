import { describe, expect, it } from 'vitest';

import { validateExternalUrl } from './openExternalGuard';

describe('validateExternalUrl', () => {
  it('accepts https URLs', () => {
    const result = validateExternalUrl('https://example.com/path?foo=bar#frag');
    expect(result).toMatchObject({ ok: true, scheme: 'https:' });
    if (result.ok) {
      expect(result.sanitizedUrl).toBe('https://example.com/path?foo=bar#frag');
    }
  });

  it('accepts http URLs (intranet docs / dev links)', () => {
    const result = validateExternalUrl('http://lobsterai-server.inner.youdao.com/login');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scheme).toBe('http:');
    }
  });

  it('accepts mailto and preserves the original string verbatim', () => {
    const original = 'mailto:foo@bar.com?subject=Hello%20World&body=Hi%20there';
    const result = validateExternalUrl(original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scheme).toBe('mailto:');
      expect(result.sanitizedUrl).toBe(original);
    }
  });

  it('trims surrounding whitespace before parsing', () => {
    const result = validateExternalUrl('  https://example.com/  ');
    expect(result.ok).toBe(true);
  });

  it('rejects file: URLs (local file probing risk)', () => {
    const result = validateExternalUrl('file:///etc/passwd');
    expect(result).toEqual({ ok: false, reason: 'scheme-not-allowed', scheme: 'file:' });
  });

  it('rejects javascript: URLs', () => {
    expect(validateExternalUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'scheme-not-allowed',
      scheme: 'javascript:',
    });
  });

  it('rejects data: URLs', () => {
    expect(validateExternalUrl('data:text/html,<script>alert(1)</script>')).toEqual({
      ok: false,
      reason: 'scheme-not-allowed',
      scheme: 'data:',
    });
  });

  it('rejects vbscript and other exotic schemes', () => {
    for (const url of ['vbscript:msgbox(1)', 'chrome://settings', 'cmd:/c calc.exe', 'intent://x']) {
      const result = validateExternalUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scheme-not-allowed');
    }
  });

  it('treats scheme matching as case-insensitive', () => {
    const result = validateExternalUrl('HTTPS://example.com');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheme).toBe('https:');
  });

  it('rejects malformed URLs without throwing', () => {
    expect(validateExternalUrl('not a url')).toEqual({
      ok: false,
      reason: 'malformed-url',
    });
    expect(validateExternalUrl('http://')).toEqual({
      ok: false,
      reason: 'malformed-url',
    });
  });

  it('rejects empty / non-string input', () => {
    expect(validateExternalUrl('')).toEqual({ ok: false, reason: 'empty-url' });
    expect(validateExternalUrl('   ')).toEqual({ ok: false, reason: 'empty-url' });
    expect(validateExternalUrl(undefined)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validateExternalUrl(null)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validateExternalUrl(123)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validateExternalUrl({})).toEqual({ ok: false, reason: 'invalid-input' });
  });
});
