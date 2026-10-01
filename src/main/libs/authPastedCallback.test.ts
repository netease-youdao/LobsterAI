import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AuthCallbackUrlError } from '../../shared/auth/constants';
import { getActiveAuthLocalCallback, startAuthLocalCallback } from './authLocalCallbackServer';
import { claimPastedAuthCallbackUrl, resolvePastedAuthCallbackUrl } from './authPastedCallback';

const waitingCallback = {
  redirectUri: 'http://127.0.0.1:36209/auth/callback',
  state: 'expected-state',
};
const returnTo = encodeURIComponent('https://lobsterai.youdao.com/portal#/login?source=electron');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
  await getActiveAuthLocalCallback()?.close();
  vi.restoreAllMocks();
});

describe('resolvePastedAuthCallbackUrl', () => {
  test('accepts the deep link an organization policy blocked', () => {
    expect(resolvePastedAuthCallbackUrl(
      '  lobsterai://auth/callback?code=f637b7d1-a7b6-4bdd-8575-1abb87ee4730\n',
      null,
    )).toEqual({ success: true, code: 'f637b7d1-a7b6-4bdd-8575-1abb87ee4730' });
  });

  test('accepts the blocked loopback address of the waiting login', () => {
    expect(resolvePastedAuthCallbackUrl(
      `http://127.0.0.1:36209/auth/callback?return_to=${returnTo}&code=loopback-code&state=expected-state`,
      waitingCallback,
    )).toEqual({ success: true, code: 'loopback-code' });
  });

  test.each([
    ['another login', 'http://127.0.0.1:36209/auth/callback?code=c&state=other-state'],
    ['another callback server', 'http://127.0.0.1:44745/auth/callback?code=c&state=expected-state'],
    ['a missing state', 'http://127.0.0.1:36209/auth/callback?code=c'],
  ])('treats a loopback address from %s as expired', (_label, url) => {
    expect(resolvePastedAuthCallbackUrl(url, waitingCallback)).toEqual({
      success: false,
      error: AuthCallbackUrlError.Expired,
    });
  });

  test('treats a loopback address as expired once no login is waiting', () => {
    expect(resolvePastedAuthCallbackUrl(
      'http://127.0.0.1:36209/auth/callback?code=c&state=expected-state',
      null,
    )).toEqual({ success: false, error: AuthCallbackUrlError.Expired });
  });

  test.each([
    ['plain text', 'f637b7d1-a7b6-4bdd-8575-1abb87ee4730'],
    ['a non-string value', 42],
    ['the portal login page', 'https://lobsterai.youdao.com/portal#/login?code=c'],
    ['another loopback path', 'http://127.0.0.1:36209/other?code=c&state=expected-state'],
    ['a loopback address without a code', 'http://127.0.0.1:36209/auth/callback?state=expected-state'],
    ['another deep link', 'lobsterai://skills/install?code=c'],
    ['a deep link without a code', 'lobsterai://auth/callback'],
  ])('rejects %s', (_label, input) => {
    expect(resolvePastedAuthCallbackUrl(input, waitingCallback)).toEqual({
      success: false,
      error: AuthCallbackUrlError.Invalid,
    });
  });
});

describe('claimPastedAuthCallbackUrl', () => {
  test('stops the waiting callback server once its blocked address is pasted', async () => {
    const onCode = vi.fn();
    const callback = await startAuthLocalCallback({ onCode });

    await expect(claimPastedAuthCallbackUrl(
      `${callback.redirectUri}?code=pasted-code&state=${callback.state}`,
    )).resolves.toEqual({ success: true, code: 'pasted-code' });

    expect(getActiveAuthLocalCallback()).toBeNull();
    expect(onCode).not.toHaveBeenCalled();
  });

  test('keeps the callback server waiting when the pasted address is rejected', async () => {
    const callback = await startAuthLocalCallback({ onCode: () => {} });

    await expect(claimPastedAuthCallbackUrl(
      `${callback.redirectUri}?code=pasted-code&state=wrong-state`,
    )).resolves.toEqual({ success: false, error: AuthCallbackUrlError.Expired });

    expect(getActiveAuthLocalCallback()).toBe(callback);
  });
});
