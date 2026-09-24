import { describe, expect, test } from 'vitest';

import {
  appendLoginParams,
  buildEmbeddedLoginTarget,
  decideNavigation,
  isAuthCodeFormat,
  isExternalLinkAllowed,
  matchCompletion,
  type NavigationPolicy,
  resolvePortalLoginUrl,
} from './loginUrlPolicy';

const PROD_LOGIN = 'https://lobsterai.youdao.com/portal#/login';
const target = { origin: 'https://lobsterai.youdao.com', completionPath: '/portal/desktop-login/complete' };
const policy: NavigationPolicy = {
  target,
  allowedTopLevelOrigins: new Set([
    'https://lobsterai.youdao.com',
    'https://lobsterai-server.youdao.com',
    'https://login.netease.com',
  ]),
};

describe('resolvePortalLoginUrl', () => {
  test('keeps a configured login page on the official origin', () => {
    expect(resolvePortalLoginUrl(PROD_LOGIN, { testMode: false })).toBe(PROD_LOGIN);
    expect(resolvePortalLoginUrl('https://lobsterai.inner.youdao.com/portal#/login', { testMode: true }))
      .toBe('https://lobsterai.inner.youdao.com/portal#/login');
  });

  test('falls back to the built-in page for any other origin, scheme or credentials', () => {
    for (const candidate of [
      'https://evil.example/portal#/login',
      'http://lobsterai.youdao.com/portal#/login',
      'https://user:pass@lobsterai.youdao.com/portal#/login',
      'https://lobsterai.inner.youdao.com/portal#/login',
      'not a url',
      null,
    ]) {
      expect(resolvePortalLoginUrl(candidate, { testMode: false })).toBe(PROD_LOGIN);
    }
  });

  test('accepts a development override only when provided', () => {
    expect(resolvePortalLoginUrl(null, {
      testMode: true,
      developmentLoginUrl: 'https://local.youdao.com:5180/login',
    })).toBe('https://local.youdao.com:5180/login');
  });
});

describe('appendLoginParams', () => {
  test('appends params inside hash route query for portal URLs', () => {
    expect(appendLoginParams(PROD_LOGIN, { source: 'electron', state: 'test-state' }))
      .toBe('https://lobsterai.youdao.com/portal#/login?source=electron&state=test-state');
  });

  test('preserves existing hash route params', () => {
    expect(appendLoginParams('https://lobsterai.youdao.com/portal#/login?invitationCode=ABC123', { source: 'electron' }))
      .toBe('https://lobsterai.youdao.com/portal#/login?invitationCode=ABC123&source=electron');
  });

  test('appends params to normal URL query when there is no hash route', () => {
    expect(appendLoginParams('https://example.com/login?foo=bar', { source: 'electron' }))
      .toBe('https://example.com/login?foo=bar&source=electron');
  });
});

describe('buildEmbeddedLoginTarget', () => {
  test('adds the embedded login parameters and derives the completion path', () => {
    const built = buildEmbeddedLoginTarget(PROD_LOGIN, { state: 'state-1', codeChallenge: 'challenge-1' });

    expect(built.loginUrl).toBe(
      'https://lobsterai.youdao.com/portal#/login?source=electron&transport=embedded&state=state-1'
      + '&code_challenge=challenge-1&code_challenge_method=S256',
    );
    expect(built.origin).toBe('https://lobsterai.youdao.com');
    expect(built.completionPath).toBe('/portal/desktop-login/complete');
  });

  test('uses the site root for history-routed development builds', () => {
    expect(buildEmbeddedLoginTarget('https://local.youdao.com:5180/login', { state: 's', codeChallenge: 'c' })
      .completionPath).toBe('/desktop-login/complete');
  });
});

describe('matchCompletion and decideNavigation', () => {
  const completion = 'https://lobsterai.youdao.com/portal/desktop-login/complete#code=abc&state=xyz';

  test('reads the code and state only from the completion fragment', () => {
    expect(matchCompletion(completion, target)).toEqual({ kind: 'completion', code: 'abc', state: 'xyz' });
    expect(matchCompletion('https://lobsterai.youdao.com/portal#/login', target)).toEqual({ kind: 'other' });
    expect(matchCompletion('https://evil.example/portal/desktop-login/complete#code=abc', target))
      .toEqual({ kind: 'other' });
  });

  test('completes, allows or blocks navigations', () => {
    expect(decideNavigation(completion, true, policy)).toBe('complete');
    expect(decideNavigation(completion, false, policy)).toBe('complete');
    expect(decideNavigation('https://lobsterai.youdao.com/portal#/enterprise/identity', true, policy)).toBe('allow');
    expect(decideNavigation('https://login.netease.com/connect/authorize?x=1', true, policy)).toBe('allow');
    expect(decideNavigation('https://evil.example/', true, policy)).toBe('block');
    expect(decideNavigation('http://lobsterai.youdao.com/portal', true, policy)).toBe('block');
    expect(decideNavigation('lobsterai://auth/callback?code=abc', true, policy)).toBe('block');
    expect(decideNavigation('https://dl.reg.163.com/webzj/v1.0.1/pub/index.html', false, policy)).toBe('allow');
    expect(decideNavigation('about:blank', false, policy)).toBe('allow');
    expect(decideNavigation('javascript:alert(1)', false, policy)).toBe('block');
  });
});

describe('isExternalLinkAllowed', () => {
  test('opens only https links on official domains', () => {
    expect(isExternalLinkAllowed('https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html')).toBe(true);
    expect(isExternalLinkAllowed('https://reg.163.com/help')).toBe(true);
    expect(isExternalLinkAllowed('http://c.youdao.com/terms')).toBe(false);
    expect(isExternalLinkAllowed('https://youdao.com.evil.example/terms')).toBe(false);
    expect(isExternalLinkAllowed('file:///etc/passwd')).toBe(false);
  });
});

describe('isAuthCodeFormat', () => {
  test('accepts the server UUID format only', () => {
    expect(isAuthCodeFormat('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isAuthCodeFormat('0f8fad5b')).toBe(false);
    expect(isAuthCodeFormat(null)).toBe(false);
  });
});
