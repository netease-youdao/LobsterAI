import { EnterpriseMemberRole } from '../../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContext,
  EnterpriseAccountIdentity,
} from '../../../shared/enterpriseAccount/types';

type EnterpriseAccountIdentityContext = Pick<
  EnterpriseAccountContext,
  'enterpriseId' | 'enterpriseName' | 'role'
> & {
  permissions: Pick<EnterpriseAccountContext['permissions'], 'manageEnterprise'>;
};

export function resolveEnterpriseAdminIdentities(
  context: EnterpriseAccountIdentityContext,
  identities: readonly EnterpriseAccountIdentity[],
): EnterpriseAccountIdentity[] {
  const candidates: EnterpriseAccountIdentity[] = [
    {
      enterpriseId: context.enterpriseId,
      enterpriseName: context.enterpriseName,
      role: context.role,
    },
    ...identities,
  ];
  const seenEnterpriseIds = new Set<number>();

  return candidates.filter(identity => {
    if (identity.role !== EnterpriseMemberRole.SuperAdmin) return false;
    if (
      identity.enterpriseId === context.enterpriseId
      && !context.permissions.manageEnterprise
    ) {
      return false;
    }
    if (seenEnterpriseIds.has(identity.enterpriseId)) return false;
    seenEnterpriseIds.add(identity.enterpriseId);
    return true;
  });
}
