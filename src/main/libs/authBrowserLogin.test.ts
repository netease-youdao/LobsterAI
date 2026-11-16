import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AuthLoginFailureReason } from '../../shared/auth/constants';
import { openBrowserLogin } from './authBrowserLogin';
import type { AuthLocalCallback } from './authLocalCallbackServer';

const BASE_URL = 'https://lobsterai.youdao.com/portal#/login';
const DEEP_LINK_URL = 'https://lobsterai.youdao.com/portal#/login?source=electron';

const localCallback: AuthLocalCallback = {
  redirectUri: 'http://127.0.0.1:43210/auth/callback',
  state: 'test-state',
  close: async () => {},
};

const startLocalCallback = () => Promise.resolve(localCallback);

describe('openBrowserLogin', () => {
  test('cancel while the callback server starts prevents opening the browser', async () => {
    const openExternal = vi.fn();
    let current = true;
    let ready: (value: AuthLocalCallback) => void = () => {};
    const pending = openBrowserLogin({
      baseUrl: BASE_URL,
      openExternal,
      startLocalCallback: () => new Promise(resolve => { ready = resolve; }),
      isCurrent: () => current,
    });
    current = false;
    ready(localCallback);
    await expect(pending).resolves.toEqual({ success: false, reason: AuthLoginFailureReason.Cancelled });
    expect(openExternal).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('opens the loopback callback login URL', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const result = await openBrowserLogin({ baseUrl: BASE_URL, openExternal, startLocalCallback });

    expect(openExternal).toHaveBeenCalledTimes(1);
    const openedUrl = openExternal.mock.calls[0][0] as string;
    expect(openedUrl).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fauth%2Fcallback');
    expect(openedUrl).toContain('state=test-state');
    expect(result).toEqual({ success: true, redirectUrl: openedUrl });
  });

  test('uses the deep link login URL when the callback server cannot start', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const result = await openBrowserLogin({
      baseUrl: BASE_URL,
      openExternal,
      startLocalCallback: () => Promise.reject(new Error('EACCES')),
    });

    expect(openExternal).toHaveBeenCalledWith(DEEP_LINK_URL);
    expect(result).toEqual({ success: true, redirectUrl: DEEP_LINK_URL });
  });

  test('falls back to the deep link URL when the callback URL is rejected', async () => {
    const openExternal = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to open'))
      .mockResolvedValueOnce(undefined);

    const result = await openBrowserLogin({ baseUrl: BASE_URL, openExternal, startLocalCallback });

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith(DEEP_LINK_URL);
    expect(result).toEqual({ success: true, redirectUrl: DEEP_LINK_URL });
  });

  test('returns the callback URL for manual use when every open request fails', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('Failed to open: Application not found'));

    const result = await openBrowserLogin({ baseUrl: BASE_URL, openExternal, startLocalCallback });

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: false,
      reason: AuthLoginFailureReason.OpenFailed,
      error: 'Failed to open: Application not found',
      redirectUrl: openExternal.mock.calls[0][0],
    });
  });

  test('treats a synchronous throw from the opener as a failed attempt', async () => {
    const openExternal = vi.fn(() => {
      throw new Error('invalid url');
    });

    const result = await openBrowserLogin({
      baseUrl: BASE_URL,
      openExternal,
      startLocalCallback: () => Promise.reject(new Error('EACCES')),
    });

    expect(result).toMatchObject({
      success: false,
      reason: AuthLoginFailureReason.OpenFailed,
      error: 'invalid url',
      redirectUrl: DEEP_LINK_URL,
    });
  });

  test('stops after a stuck open request and returns the callback URL', async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn(() => new Promise<void>(() => {}));

    const pending = openBrowserLogin({
      baseUrl: BASE_URL,
      openExternal,
      startLocalCallback,
      openTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      reason: AuthLoginFailureReason.OpenTimedOut,
      redirectUrl: openExternal.mock.calls[0][0],
    });
  });

  test('ignores an open request that settles after the timeout', async () => {
    vi.useFakeTimers();
    let rejectOpen: (error: Error) => void = () => {};
    const openExternal = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectOpen = reject;
    }));

    const pending = openBrowserLogin({
      baseUrl: BASE_URL,
      openExternal,
      startLocalCallback,
      openTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    rejectOpen(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.reason).toBe(AuthLoginFailureReason.OpenTimedOut);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
