import {
  EnterpriseApiErrorCode,
  EnterpriseQuotaReason,
} from './constants';
import type { EnterpriseQuotaErrorDetails } from './types';

const ENTERPRISE_QUOTA_REASON_BY_CODE: Record<number, EnterpriseQuotaReason> = {
  [EnterpriseApiErrorCode.MemberMonthlyQuotaExhausted]:
    EnterpriseQuotaReason.MemberMonthlyQuotaExhausted,
  [EnterpriseApiErrorCode.EnterprisePoolExhausted]:
    EnterpriseQuotaReason.EnterprisePoolExhausted,
  [EnterpriseApiErrorCode.EnterpriseCreditBatchesExpired]:
    EnterpriseQuotaReason.EnterpriseCreditBatchesExpired,
};

export function normalizeEnterpriseApiErrorCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

export function resolveEnterpriseQuotaError(
  code: unknown,
  message = '',
): EnterpriseQuotaErrorDetails | null {
  const normalizedCode = normalizeEnterpriseApiErrorCode(code)
    ?? normalizeEnterpriseApiErrorCode(message.match(/\b4160[678]\b/)?.[0]);
  if (normalizedCode === null) return null;

  const reason = ENTERPRISE_QUOTA_REASON_BY_CODE[normalizedCode];
  return reason ? { code: normalizedCode, reason } : null;
}

export function isEnterpriseQuotaReason(value: unknown): value is EnterpriseQuotaReason {
  return Object.values(EnterpriseQuotaReason).some(reason => reason === value);
}
