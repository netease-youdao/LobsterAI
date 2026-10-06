import { isEnterpriseAccountOwnerKey } from '../../../shared/auth/accountOwner';
import { AuthSubscriptionStatus } from '../../../shared/auth/constants';
import {
  EnterpriseAccountMode,
  EnterpriseMemberRole,
} from '../../../shared/enterpriseAccount/constants';
import type { RootState } from '../../store';

export const selectEnterpriseAccountContext = (state: RootState) => (
  state.enterpriseAccount.context
);

export const selectIsEnterpriseAccount = (state: RootState): boolean => (
  state.enterpriseAccount.context !== null
  || isEnterpriseAccountOwnerKey(state.auth.ownerAccountKey)
  || state.auth.user?.accountMode === EnterpriseAccountMode.Enterprise
  || state.auth.quota?.accountMode === EnterpriseAccountMode.Enterprise
  || state.auth.quota?.subscriptionStatus === AuthSubscriptionStatus.Enterprise
);

export const selectIsEnterpriseSuperAdmin = (state: RootState): boolean => (
  state.enterpriseAccount.context?.role === EnterpriseMemberRole.SuperAdmin
);
