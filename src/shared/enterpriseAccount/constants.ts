export const EnterpriseAccountMode = {
  Personal: 'personal',
  Enterprise: 'enterprise',
} as const;

export type EnterpriseAccountMode =
  typeof EnterpriseAccountMode[keyof typeof EnterpriseAccountMode];

export const EnterpriseMemberRole = {
  SuperAdmin: 'super_admin',
  Member: 'member',
} as const;

export type EnterpriseMemberRole =
  typeof EnterpriseMemberRole[keyof typeof EnterpriseMemberRole];

export const EnterpriseQuotaReason = {
  MemberMonthlyQuotaExhausted: 'member_monthly_quota_exhausted',
  EnterprisePoolExhausted: 'enterprise_pool_exhausted',
  EnterpriseCreditBatchesExpired: 'enterprise_credit_batches_expired',
} as const;

export type EnterpriseQuotaReason =
  typeof EnterpriseQuotaReason[keyof typeof EnterpriseQuotaReason];

export const EnterpriseQuotaRequestType = {
  MemberQuota: 'member_quota',
  EnterprisePool: 'enterprise_pool',
} as const;

export type EnterpriseQuotaRequestType =
  typeof EnterpriseQuotaRequestType[keyof typeof EnterpriseQuotaRequestType];

export const EnterpriseApiErrorCode = {
  NotFound: 41600,
  Unavailable: 41601,
  NotMember: 41602,
  PermissionDenied: 41603,
  EnterpriseLimitReached: 41604,
  MemberLimitReached: 41605,
  MemberMonthlyQuotaExhausted: 41606,
  EnterprisePoolExhausted: 41607,
  EnterpriseCreditBatchesExpired: 41608,
  DuplicateInvitation: 41609,
  InvalidPackAmount: 41610,
  InvalidAdminTransferTarget: 41611,
  AccountModeMismatch: 41612,
} as const;

export type EnterpriseApiErrorCode =
  typeof EnterpriseApiErrorCode[keyof typeof EnterpriseApiErrorCode];

export const EnterpriseAccountIpcChannel = {
  GetContext: 'enterpriseAccount:getContext',
  GetIdentities: 'enterpriseAccount:getIdentities',
  RequestQuotaIncrease: 'enterpriseAccount:requestQuotaIncrease',
  ContextInvalidated: 'enterpriseAccount:contextInvalidated',
} as const;

export type EnterpriseAccountIpcChannel =
  typeof EnterpriseAccountIpcChannel[keyof typeof EnterpriseAccountIpcChannel];

export const EnterpriseAccountStoreKey = {
  Context: 'enterprise_account_context',
} as const;

export const EnterpriseAccountRequestHeader = {
  AccountMode: 'X-LobsterAI-Account-Mode',
  EnterpriseId: 'X-LobsterAI-Enterprise-Id',
} as const;

export const EnterpriseQuotaMessageMetadataKey = {
  ErrorCode: 'enterpriseErrorCode',
  Reason: 'enterpriseQuotaReason',
} as const;
