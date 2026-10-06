import { AuthSessionStatus } from '@shared/auth/constants';
import { describe, expect, test } from 'vitest';

import authReducer, {
  invalidateAuthAccountContext,
  setAuthExpired,
  setAuthTemporarilyUnavailable,
  setLoggedIn,
  setLoggedOut,
  setProfileSummary,
  type UserProfile,
  type UserQuota,
} from './authSlice';

const user: UserProfile = {
  yid: 'employee',
  userId: '6',
  nickname: 'Employee',
  avatarUrl: null,
};

const quota: UserQuota = {
  planName: '团队版',
  subscriptionStatus: 'enterprise',
  creditsLimit: 5_000,
  creditsUsed: 0,
  creditsRemaining: 5_000,
  mediaGenerationEntitled: true,
};

describe('auth session status', () => {
  test('preserves the authenticated snapshot during a temporary verification failure', () => {
    const loggedIn = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const unavailable = authReducer(
      loggedIn,
      setAuthTemporarilyUnavailable({ hasCredentials: true }),
    );

    expect(unavailable).toMatchObject({
      isLoggedIn: true,
      isLoading: false,
      sessionStatus: AuthSessionStatus.TemporarilyUnavailable,
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    });
  });

  test('restores a cached user when startup verification is temporarily unavailable', () => {
    const unavailable = authReducer(
      undefined,
      setAuthTemporarilyUnavailable({
        hasCredentials: true,
        cachedUser: user,
      }),
    );

    expect(unavailable).toMatchObject({
      isLoggedIn: true,
      sessionStatus: AuthSessionStatus.TemporarilyUnavailable,
      user,
    });
  });

  test('clears account-scoped state after terminal expiration', () => {
    const loggedIn = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const expired = authReducer(loggedIn, setAuthExpired());

    expect(expired).toMatchObject({
      isLoggedIn: false,
      isLoading: false,
      sessionStatus: AuthSessionStatus.Expired,
      user: null,
      quota: null,
      ownerAccountKey: null,
      accountGeneration: 2,
    });
  });
});

describe('auth account scope', () => {
  test('increments account generation only when the owner changes', () => {
    const enterpriseA = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const refreshed = authReducer(enterpriseA, setLoggedIn({
      user,
      quota: { ...quota, creditsUsed: 10 },
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const enterpriseB = authReducer(refreshed, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1002',
    }));

    expect(enterpriseA.accountGeneration).toBe(1);
    expect(refreshed.accountGeneration).toBe(1);
    expect(enterpriseB.accountGeneration).toBe(2);
  });

  test('does not carry a personal profile summary into a different account', () => {
    const personalA = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:6',
    }));
    const withSummary = authReducer(personalA, setProfileSummary({
      id: 6,
      nickname: 'Employee A',
      avatarUrl: null,
      totalCreditsRemaining: 123,
      creditItems: [],
    }));
    const personalB = authReducer(withSummary, setLoggedIn({
      user: { ...user, userId: '7', yid: 'employee-b' },
      quota,
      ownerAccountKey: 'personal:7',
    }));

    expect(personalB.profileSummary).toBeNull();
  });

  test('invalidates the owner generation on logout', () => {
    const loggedIn = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const loggedOut = authReducer(loggedIn, setLoggedOut());

    expect(loggedOut.ownerAccountKey).toBeNull();
    expect(loggedOut.accountGeneration).toBe(2);
  });

  test('invalidates in-flight work and fails closed when enterprise context expires', () => {
    const loggedIn = authReducer(undefined, setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:6:1001',
    }));
    const invalidated = authReducer(loggedIn, invalidateAuthAccountContext());

    expect(invalidated.ownerAccountKey).toBe('enterprise:6:1001');
    expect(invalidated.accountGeneration).toBe(2);
    expect(invalidated.quota).toBeNull();
    expect(invalidated.profileSummary).toBeNull();
  });
});
