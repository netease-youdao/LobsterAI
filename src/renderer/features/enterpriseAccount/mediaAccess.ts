import { isEnterpriseAccountOwnerKey } from '../../../shared/auth/accountOwner';
import { AuthSubscriptionStatus } from '../../../shared/auth/constants';
import type { UserQuota } from '../../store/slices/authSlice';

export const MediaGenerationAccessReason = {
  Allowed: 'allowed',
  LoginRequired: 'login_required',
  NotEntitled: 'not_entitled',
  EnterpriseContextUnavailable: 'enterprise_context_unavailable',
  EnterpriseQuotaUnavailable: 'enterprise_quota_unavailable',
} as const;

export type MediaGenerationAccessReason =
  typeof MediaGenerationAccessReason[keyof typeof MediaGenerationAccessReason];

export interface MediaGenerationAccessDecision {
  allowed: boolean;
  reason: MediaGenerationAccessReason;
}

export const enterpriseMediaAccountSnapshotsMatch = (input: {
  isEnterpriseAccount: boolean;
  ownerAccountKey: string | null;
  contextOwnerAccountKey: string | null;
  quotaOwnerAccountKey: string | null;
  quotaAccountMode?: 'personal' | 'enterprise';
  quotaEnterpriseId?: number;
  contextEnterpriseId?: number;
}): boolean => (
  !input.isEnterpriseAccount
  || (
    isEnterpriseAccountOwnerKey(input.ownerAccountKey)
    && input.quotaAccountMode === 'enterprise'
    && typeof input.quotaEnterpriseId === 'number'
    && input.quotaEnterpriseId === input.contextEnterpriseId
    && input.contextOwnerAccountKey === input.ownerAccountKey
    && input.quotaOwnerAccountKey === input.ownerAccountKey
  )
);

export const resolveMediaGenerationAccess = (input: {
  isLoggedIn: boolean;
  quota: UserQuota | null | undefined;
  isEnterpriseAccount: boolean;
  enterpriseAccountSnapshotsMatch: boolean;
  enterpriseQuotaAvailable?: boolean;
}): MediaGenerationAccessDecision => {
  if (!input.isLoggedIn) {
    return { allowed: false, reason: MediaGenerationAccessReason.LoginRequired };
  }

  const explicitEntitlement = input.quota?.mediaGenerationEntitled;
  const entitled = typeof explicitEntitlement === 'boolean'
    ? explicitEntitlement
    : !input.isEnterpriseAccount && (
      input.quota?.subscriptionStatus === AuthSubscriptionStatus.Active
      || input.quota?.hasPaidCredits === true
    );

  if (!entitled) {
    return { allowed: false, reason: MediaGenerationAccessReason.NotEntitled };
  }

  if (input.isEnterpriseAccount && !input.enterpriseAccountSnapshotsMatch) {
    return {
      allowed: false,
      reason: MediaGenerationAccessReason.EnterpriseContextUnavailable,
    };
  }

  if (input.isEnterpriseAccount && input.enterpriseQuotaAvailable !== true) {
    return {
      allowed: false,
      reason: MediaGenerationAccessReason.EnterpriseQuotaUnavailable,
    };
  }

  return { allowed: true, reason: MediaGenerationAccessReason.Allowed };
};
