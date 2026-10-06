import type {
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
  EnterpriseQuotaRequestType,
} from './constants';

export interface EnterpriseAccountPermissions {
  manageEnterprise: boolean;
  adjustMemberQuota: boolean;
  rechargeEnterprise: boolean;
}

export interface EnterpriseMemberQuota {
  limit: number;
  used: number;
  reserved?: number;
  remaining: number;
  refreshCycle?: 'natural_month' | 'natural_week';
  periodStart?: string;
  periodEndExclusive?: string;
}

export interface EnterpriseCreditPool {
  total: number;
  used: number;
  remaining: number;
}

export interface EnterpriseAccountContext {
  accountMode: 'enterprise';
  enterpriseId: number;
  memberId: number;
  enterpriseName: string;
  role: EnterpriseMemberRole;
  permissions: EnterpriseAccountPermissions;
  memberQuota: EnterpriseMemberQuota;
  enterprisePool: EnterpriseCreditPool;
  quotaStatus: {
    available: boolean;
    reason: EnterpriseQuotaReason | null;
    errorCode: number | null;
  };
}

export interface EnterpriseQuotaErrorDetails {
  code: number;
  reason: EnterpriseQuotaReason;
}

export interface EnterpriseAccountContextResult {
  success: boolean;
  context: EnterpriseAccountContext | null;
  error?: string;
}

export interface EnterpriseAccountIdentity {
  enterpriseId: number;
  enterpriseName: string;
  role: EnterpriseMemberRole;
}

export interface EnterpriseAccountIdentitiesResult {
  success: boolean;
  identities: EnterpriseAccountIdentity[];
  error?: string;
}

export interface EnterpriseQuotaRequestResult {
  success: boolean;
  requestId?: number;
  requestType?: EnterpriseQuotaRequestType;
  status?: 'pending';
  created?: boolean;
  error?: string;
}
