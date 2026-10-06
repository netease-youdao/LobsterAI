import { describe, expect, test } from 'vitest';

import type { UserQuota } from '../../store/slices/authSlice';
import {
  enterpriseMediaAccountSnapshotsMatch,
  MediaGenerationAccessReason,
  resolveMediaGenerationAccess,
} from './mediaAccess';

const enterpriseQuota: UserQuota = {
  planName: '团队版',
  subscriptionStatus: 'enterprise',
  creditsLimit: 5000,
  creditsUsed: 0,
  creditsRemaining: 5000,
  hasPaidCredits: true,
  mediaGenerationEntitled: true,
  accountMode: 'enterprise',
  enterpriseId: 1001,
};

describe('resolveMediaGenerationAccess', () => {
  test('allows an explicitly entitled enterprise account', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: enterpriseQuota,
      isEnterpriseAccount: true,
      enterpriseAccountSnapshotsMatch: true,
      enterpriseQuotaAvailable: true,
    })).toEqual({
      allowed: true,
      reason: MediaGenerationAccessReason.Allowed,
    });
  });

  test('lets explicit false override paid-credit compatibility', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: { ...enterpriseQuota, mediaGenerationEntitled: false },
      isEnterpriseAccount: true,
      enterpriseAccountSnapshotsMatch: true,
      enterpriseQuotaAvailable: true,
    }).reason).toBe(MediaGenerationAccessReason.NotEntitled);
  });

  test('fails closed for an enterprise account without an explicit entitlement', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: {
        ...enterpriseQuota,
        mediaGenerationEntitled: undefined,
        hasPaidCredits: true,
      },
      isEnterpriseAccount: true,
      enterpriseAccountSnapshotsMatch: true,
      enterpriseQuotaAvailable: true,
    }).reason).toBe(MediaGenerationAccessReason.NotEntitled);
  });

  test('distinguishes an enterprise quota block from a purchase gate', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: enterpriseQuota,
      isEnterpriseAccount: true,
      enterpriseAccountSnapshotsMatch: true,
      enterpriseQuotaAvailable: false,
    })).toEqual({
      allowed: false,
      reason: MediaGenerationAccessReason.EnterpriseQuotaUnavailable,
    });
  });

  test('fails closed while enterprise context does not match the account owner', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: enterpriseQuota,
      isEnterpriseAccount: true,
      enterpriseAccountSnapshotsMatch: false,
      enterpriseQuotaAvailable: true,
    }).reason).toBe(MediaGenerationAccessReason.EnterpriseContextUnavailable);
  });

  test('preserves the personal paid-credit fallback for older servers', () => {
    expect(resolveMediaGenerationAccess({
      isLoggedIn: true,
      quota: {
        ...enterpriseQuota,
        subscriptionStatus: 'free',
        mediaGenerationEntitled: undefined,
        hasPaidCredits: true,
      },
      isEnterpriseAccount: false,
      enterpriseAccountSnapshotsMatch: true,
    }).allowed).toBe(true);
  });
});

describe('enterpriseMediaAccountSnapshotsMatch', () => {
  const matchingInput = {
    isEnterpriseAccount: true,
    ownerAccountKey: 'enterprise:6:1001',
    contextOwnerAccountKey: 'enterprise:6:1001',
    quotaOwnerAccountKey: 'enterprise:6:1001',
    quotaAccountMode: 'enterprise' as const,
    quotaEnterpriseId: 1001,
    contextEnterpriseId: 1001,
  };

  test('requires quota enterprise id, context enterprise id, and owner to match', () => {
    expect(enterpriseMediaAccountSnapshotsMatch(matchingInput)).toBe(true);
    expect(enterpriseMediaAccountSnapshotsMatch({
      ...matchingInput,
      quotaEnterpriseId: 1002,
      quotaOwnerAccountKey: 'enterprise:6:1002',
    })).toBe(false);
    expect(enterpriseMediaAccountSnapshotsMatch({
      ...matchingInput,
      contextOwnerAccountKey: 'enterprise:6:1002',
    })).toBe(false);
    expect(enterpriseMediaAccountSnapshotsMatch({
      ...matchingInput,
      quotaAccountMode: 'personal',
    })).toBe(false);
  });
});
