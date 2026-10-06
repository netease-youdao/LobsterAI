import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { describe, expect, test } from 'vitest';

import type { RootState } from '../../store';
import { selectIsEnterpriseAccount } from './selectors';

interface SelectorStateOptions {
  contextPresent?: boolean;
  ownerAccountKey?: string | null;
  quotaAccountMode?: 'personal' | 'enterprise';
  subscriptionStatus?: string;
  userAccountMode?: 'personal' | 'enterprise';
}

const createState = ({
  contextPresent = false,
  ownerAccountKey = 'personal:6',
  quotaAccountMode = EnterpriseAccountMode.Personal,
  subscriptionStatus = AuthSubscriptionStatus.Free,
  userAccountMode = EnterpriseAccountMode.Personal,
}: SelectorStateOptions = {}): RootState => ({
  auth: {
    isLoggedIn: true,
    isLoading: false,
    sessionStatus: 'authenticated',
    user: {
      yid: 'tester',
      nickname: 'Tester',
      avatarUrl: null,
      accountMode: userAccountMode,
    },
    quota: {
      planName: 'Free',
      subscriptionStatus,
      creditsLimit: 100,
      creditsUsed: 0,
      creditsRemaining: 100,
      accountMode: quotaAccountMode,
    },
    profileSummary: null,
    ownerAccountKey,
    accountGeneration: 1,
  },
  enterpriseAccount: {
    context: contextPresent
      ? {} as RootState['enterpriseAccount']['context']
      : null,
  },
} as RootState);

describe('selectIsEnterpriseAccount', () => {
  test('allows a personal account to participate in personal credit campaigns', () => {
    expect(selectIsEnterpriseAccount(createState())).toBe(false);
  });

  test('recognizes every persisted enterprise account marker', () => {
    expect(selectIsEnterpriseAccount(createState({ contextPresent: true }))).toBe(true);
    expect(selectIsEnterpriseAccount(createState({ ownerAccountKey: 'enterprise:6:1001' })))
      .toBe(true);
    expect(selectIsEnterpriseAccount(createState({
      userAccountMode: EnterpriseAccountMode.Enterprise,
    }))).toBe(true);
    expect(selectIsEnterpriseAccount(createState({
      quotaAccountMode: EnterpriseAccountMode.Enterprise,
    }))).toBe(true);
    expect(selectIsEnterpriseAccount(createState({
      subscriptionStatus: AuthSubscriptionStatus.Enterprise,
    }))).toBe(true);
  });

  test('becomes eligible again after switching back to the personal account', () => {
    const enterpriseState = createState({
      contextPresent: true,
      ownerAccountKey: 'enterprise:6:1001',
      quotaAccountMode: EnterpriseAccountMode.Enterprise,
      subscriptionStatus: AuthSubscriptionStatus.Enterprise,
      userAccountMode: EnterpriseAccountMode.Enterprise,
    });
    const personalState = createState();

    expect(selectIsEnterpriseAccount(enterpriseState)).toBe(true);
    expect(selectIsEnterpriseAccount(personalState)).toBe(false);
  });
});
