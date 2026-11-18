import { AuthSessionChangeReason, AuthSessionStatus, AuthSubscriptionStatus } from '@shared/auth/constants';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { setEnterpriseAccountContext } from '../features/enterpriseAccount/enterpriseAccountSlice';
import { store } from '../store';
import { setLoggedOut } from '../store/slices/authSlice';
import { clearServerModels } from '../store/slices/modelSlice';
import { authService } from './auth';

vi.mock('./logReporter', async importOriginal => ({
  ...await importOriginal<typeof import('./logReporter')>(),
  reportYdAnalyzer: vi.fn(),
}));

const user = { yid: 'offline-user', nickname: 'Offline User', avatarUrl: null };
const quota = {
  planName: 'Test', subscriptionStatus: AuthSubscriptionStatus.Active,
  creditsLimit: 100, creditsUsed: 10, creditsRemaining: 90,
};
const profile = { id: 1, nickname: user.nickname, avatarUrl: null, totalCreditsRemaining: 90, creditItems: [] };
const model = { modelId: 'recovery-model', modelName: 'Recovery Model', provider: 'fixture', apiFormat: 'openai', accessible: true };
const restored = { success: true, status: AuthSessionStatus.Authenticated, user, quota, enterpriseContext: null };
const unavailable = { success: false, status: AuthSessionStatus.TemporarilyUnavailable, hasCredentials: true, cachedUser: user };

function setup(cachedUser: typeof user | null = user) {
  let online = false;
  let focus: ((state: { isFocused: boolean }) => void) | undefined;
  const getUser = vi.fn<Window['electron']['auth']['getUser']>(async () => online ? restored : { ...unavailable, cachedUser });
  const getModels = vi.fn(async () => ({ success: true, models: [model] }));
  const getQuota = vi.fn(async () => ({ success: true, quota, enterpriseContext: null }));
  const getProfileSummary = vi.fn(async () => ({ success: true, data: profile }));
  const getPricingCatalog = vi.fn(async () => ({ success: true, textModels: [model] }));
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: {
      auth: {
        getUser, getModels, getQuota, getProfileSummary, getPricingCatalog,
        logout: vi.fn(async () => {}),
        getPendingCallback: vi.fn(async () => null),
        onCallback: vi.fn(() => () => {}),
        onSessionChanged: vi.fn(() => () => {}),
        onLifecycleEvent: vi.fn(() => () => {}),
        onQuotaChanged: vi.fn(() => () => {}),
      },
      enterpriseAccount: { onContextInvalidated: vi.fn(() => () => {}) },
      window: { onStateChanged: vi.fn((listener: typeof focus) => { focus = listener; return () => {}; }) },
      log: { fromRenderer: vi.fn() },
    },
  });
  return {
    getUser, getModels, getQuota, getProfileSummary, getPricingCatalog,
    restoreNetwork: () => { online = true; },
    focusWindow: () => { focus?.({ isFocused: true }); },
  };
}

function expectRecovered() {
  expect(store.getState().auth).toMatchObject({
    isLoggedIn: true, sessionStatus: AuthSessionStatus.Authenticated,
    ownerAccountKey: 'personal:offline-user', user, quota, profileSummary: profile,
  });
  expect(store.getState().model.availableModels).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: model.modelId, accessible: true }),
  ]));
}

beforeEach(() => {
  vi.useFakeTimers();
  store.dispatch(setLoggedOut());
  store.dispatch(clearServerModels());
  store.dispatch(setEnterpriseAccountContext(null));
});

afterEach(() => {
  authService.destroy();
  store.dispatch(setLoggedOut());
  store.dispatch(clearServerModels());
  store.dispatch(setEnterpriseAccountContext(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('account recovery after offline startup', () => {
  test.each([user, null])('restores the full account after online or manual retry (cached user: %j)', async cachedUser => {
    const f = setup(cachedUser);
    await authService.init();
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: true, sessionStatus: AuthSessionStatus.TemporarilyUnavailable, ownerAccountKey: null,
    });
    expect(f.getModels).not.toHaveBeenCalled();
    f.restoreNetwork();
    await authService.recoverAccount();
    expectRecovered();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.getUser).toHaveBeenCalledTimes(2);
    expect(f.getModels).toHaveBeenCalledOnce();
  });

  test('window focus recovers an incomplete cached account', async () => {
    const f = setup();
    await authService.init();
    f.restoreNetwork();
    f.focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expectRecovered();
  });

  test('keeps retrying beyond a long outage without another online event', async () => {
    const f = setup();
    await authService.init();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.getUser.mock.calls.length).toBeGreaterThan(4);
    expect(f.getUser.mock.calls.length).toBeLessThan(10);
    f.restoreNetwork();
    await vi.advanceTimersByTimeAsync(60_000);
    expectRecovered();
    const calls = f.getUser.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.getUser).toHaveBeenCalledTimes(calls);
  });

  test('online before the offline startup request settles performs a fresh restore afterwards', async () => {
    const f = setup();
    let finish!: (value: typeof unavailable) => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const init = authService.init();
    await vi.advanceTimersByTimeAsync(0);
    f.restoreNetwork();
    const recovery = authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getUser).toHaveBeenCalledOnce();
    finish(unavailable);
    await Promise.all([init, recovery]);
    expectRecovered();
    expect(f.getUser).toHaveBeenCalledTimes(2);
  });

  test('concurrent signals coalesce and a new signal during a failed recovery is not lost', async () => {
    const f = setup();
    await authService.init();
    let finish!: (value: typeof unavailable) => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(0);
    f.restoreNetwork();
    const second = authService.recoverAccount();
    const third = authService.recoverAccount();
    expect(f.getUser).toHaveBeenCalledTimes(2);
    finish(unavailable);
    await Promise.all([first, second, third]);
    expectRecovered();
    expect(f.getUser).toHaveBeenCalledTimes(3);
  });

  test('healthy authenticated accounts refresh data without reloading the auth snapshot', async () => {
    const f = setup();
    f.restoreNetwork();
    await authService.init();
    await Promise.all([authService.recoverAccount(), authService.recoverAccount()]);
    expectRecovered();
    expect(f.getUser).toHaveBeenCalledOnce();
    expect(f.getQuota).toHaveBeenCalledOnce();
  });

  test('signed-out recovery only loads the public model catalog', async () => {
    const f = setup();
    await authService.recoverAccount();
    expect(f.getUser).not.toHaveBeenCalled();
    expect(f.getPricingCatalog).toHaveBeenCalledOnce();
    expect(store.getState().auth.isLoggedIn).toBe(false);
    expect(store.getState().model.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: model.modelId, accessible: false }),
    ]));
  });

  test.each([false, true])('logout cancels recovery and ignores late responses (reject: %s)', async reject => {
    const f = setup();
    await authService.init();
    let finish!: () => void;
    f.getUser.mockImplementationOnce(() => new Promise((resolve, rejectRequest) => {
      finish = () => reject ? rejectRequest(new Error('old offline request')) : resolve(restored);
    }));
    const recovery = authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(0);
    await authService.logout();
    finish();
    await recovery;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.getState().auth).toMatchObject({ isLoggedIn: false, sessionStatus: AuthSessionStatus.Unauthenticated });
    expect(f.getUser).toHaveBeenCalledTimes(2);
    expect(f.getModels).not.toHaveBeenCalled();
  });

  test('a new account supersedes an old in-flight recovery', async () => {
    const f = setup();
    await authService.init();
    let finish!: (value: typeof restored) => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const recovery = authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(0);
    const nextUser = { ...user, yid: 'next-user' };
    f.getUser.mockResolvedValueOnce({ ...restored, user: nextUser });
    await authService.handleSessionChanged({ status: AuthSessionStatus.Authenticated, reason: AuthSessionChangeReason.UserLogin });
    finish(restored);
    await recovery;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.getState().auth).toMatchObject({ user: nextUser, ownerAccountKey: 'personal:next-user' });
    expect(f.getUser).toHaveBeenCalledTimes(3);
  });

  test('terminal expiration stops automatic retries', async () => {
    const f = setup();
    await authService.init();
    f.getUser.mockResolvedValueOnce({ success: false, status: AuthSessionStatus.Expired, hasCredentials: false, cachedUser: null });
    await authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.Expired);
    expect(f.getUser).toHaveBeenCalledTimes(2);
  });

  test('service destruction cancels timers and ignores an in-flight restore', async () => {
    const f = setup();
    await authService.init();
    let finish!: (value: typeof restored) => void;
    f.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const recovery = authService.recoverAccount();
    await vi.advanceTimersByTimeAsync(0);
    authService.destroy();
    finish(restored);
    await recovery;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.getState().auth.ownerAccountKey).toBeNull();
    expect(f.getUser).toHaveBeenCalledTimes(2);
  });

  test('cached credentials never fabricate an authenticated account owner', async () => {
    const f = setup();
    await authService.init();
    await authService.recoverAccount();
    expect(store.getState().auth.ownerAccountKey).toBeNull();
    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.TemporarilyUnavailable);
    expect(f.getModels).not.toHaveBeenCalled();
    expect(f.getProfileSummary).not.toHaveBeenCalled();
  });
});
