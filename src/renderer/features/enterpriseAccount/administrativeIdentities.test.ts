import { describe, expect, test } from 'vitest';

import {
  EnterpriseAccountMode,
  EnterpriseMemberRole,
} from '../../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContext,
  EnterpriseAccountIdentity,
} from '../../../shared/enterpriseAccount/types';
import { resolveEnterpriseAdminIdentities } from './administrativeIdentities';

const createContext = (
  role: EnterpriseAccountContext['role'] = EnterpriseMemberRole.SuperAdmin,
  canManageEnterprise = role === EnterpriseMemberRole.SuperAdmin,
): EnterpriseAccountContext => ({
  accountMode: EnterpriseAccountMode.Enterprise,
  enterpriseId: 1001,
  memberId: 2001,
  enterpriseName: 'Current Enterprise',
  role,
  permissions: {
    manageEnterprise: canManageEnterprise,
    adjustMemberQuota: role === EnterpriseMemberRole.SuperAdmin,
    rechargeEnterprise: role === EnterpriseMemberRole.SuperAdmin,
  },
  memberQuota: { limit: 100, used: 40, remaining: 60 },
  enterprisePool: { total: 1000, used: 400, remaining: 600 },
  quotaStatus: { available: true, reason: null, errorCode: null },
});

describe('resolveEnterpriseAdminIdentities', () => {
  test('keeps only administrator enterprises with the current enterprise first', () => {
    const identities: EnterpriseAccountIdentity[] = [
      {
        enterpriseId: 1002,
        enterpriseName: 'Member Enterprise',
        role: EnterpriseMemberRole.Member,
      },
      {
        enterpriseId: 1003,
        enterpriseName: 'Managed Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
      {
        enterpriseId: 1001,
        enterpriseName: 'Duplicate Current Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
    ];

    expect(resolveEnterpriseAdminIdentities(createContext(), identities)).toEqual([
      {
        enterpriseId: 1001,
        enterpriseName: 'Current Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
      {
        enterpriseId: 1003,
        enterpriseName: 'Managed Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
    ]);
  });

  test('does not treat the current member enterprise as manageable', () => {
    expect(resolveEnterpriseAdminIdentities(
      createContext(EnterpriseMemberRole.Member),
      [
        {
          enterpriseId: 1002,
          enterpriseName: 'Managed Enterprise',
          role: EnterpriseMemberRole.SuperAdmin,
        },
      ],
    )).toEqual([
      {
        enterpriseId: 1002,
        enterpriseName: 'Managed Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
    ]);
  });

  test('returns no enterprises when the account has only member identities', () => {
    expect(resolveEnterpriseAdminIdentities(
      createContext(EnterpriseMemberRole.Member),
      [
        {
          enterpriseId: 1002,
          enterpriseName: 'Member Enterprise',
          role: EnterpriseMemberRole.Member,
        },
      ],
    )).toEqual([]);
  });

  test('preserves an explicit restriction on the current administrator context', () => {
    expect(resolveEnterpriseAdminIdentities(
      createContext(EnterpriseMemberRole.SuperAdmin, false),
      [
        {
          enterpriseId: 1001,
          enterpriseName: 'Restricted Current Enterprise',
          role: EnterpriseMemberRole.SuperAdmin,
        },
        {
          enterpriseId: 1002,
          enterpriseName: 'Managed Enterprise',
          role: EnterpriseMemberRole.SuperAdmin,
        },
      ],
    )).toEqual([
      {
        enterpriseId: 1002,
        enterpriseName: 'Managed Enterprise',
        role: EnterpriseMemberRole.SuperAdmin,
      },
    ]);
  });
});
