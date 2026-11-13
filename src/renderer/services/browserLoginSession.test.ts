import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  BROWSER_LOGIN_SESSION_TTL_MS,
  browserLoginSession,
  BrowserLoginStatus,
} from './browserLoginSession';

const LOGIN_URL = 'https://lobsterai.youdao.com/portal#/login?source=electron&state=s';

describe('browserLoginSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    browserLoginSession.clear();
    vi.useRealTimers();
  });

  test('moves from opening to waiting and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = browserLoginSession.subscribe(listener);

    browserLoginSession.start();
    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.Opening, url: null });

    browserLoginSession.handOff(LOGIN_URL);
    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.Waiting, url: LOGIN_URL });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test('removes the invalidated link while a retry is opening', () => {
    browserLoginSession.start();
    browserLoginSession.fail(LOGIN_URL);

    browserLoginSession.start();
    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.Opening, url: null });
  });

  test('a failure without a link keeps an explicit retry state', () => {
    browserLoginSession.start();
    browserLoginSession.fail(null);

    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.OpenFailed, url: null });
  });

  test('expires once the login link can no longer complete a login', () => {
    browserLoginSession.start();
    browserLoginSession.handOff(LOGIN_URL);

    vi.advanceTimersByTime(BROWSER_LOGIN_SESSION_TTL_MS - 1);
    expect(browserLoginSession.getSnapshot()?.status).toBe(BrowserLoginStatus.Waiting);
    vi.advanceTimersByTime(1);
    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.Expired, url: null });
    expect(browserLoginSession.isCancelled()).toBe(true);
  });

  test('a retry restarts the expiry window', () => {
    browserLoginSession.start();
    browserLoginSession.handOff(LOGIN_URL);
    vi.advanceTimersByTime(BROWSER_LOGIN_SESSION_TTL_MS - 1_000);

    browserLoginSession.start();
    browserLoginSession.handOff(LOGIN_URL);
    vi.advanceTimersByTime(2_000);

    expect(browserLoginSession.getSnapshot()?.status).toBe(BrowserLoginStatus.Waiting);
  });

  test('a callback switches to verification and an exchange failure stays visible', () => {
    browserLoginSession.start();
    browserLoginSession.handOff(LOGIN_URL);
    browserLoginSession.verify();
    vi.advanceTimersByTime(BROWSER_LOGIN_SESSION_TTL_MS);
    expect(browserLoginSession.getSnapshot()?.status).toBe(BrowserLoginStatus.Verifying);
    browserLoginSession.verificationFailed();
    expect(browserLoginSession.getSnapshot()).toEqual({ status: BrowserLoginStatus.Failed, url: null });
  });

  test('cancel suppresses callbacks until another login is started', () => {
    browserLoginSession.start();
    browserLoginSession.handOff(LOGIN_URL);
    browserLoginSession.cancel();
    expect(browserLoginSession.getSnapshot()).toBeNull();
    expect(browserLoginSession.isCancelled()).toBe(true);
    vi.advanceTimersByTime(BROWSER_LOGIN_SESSION_TTL_MS);
    expect(browserLoginSession.getSnapshot()).toBeNull();
    browserLoginSession.start();
    expect(browserLoginSession.isCancelled()).toBe(false);
  });
});
