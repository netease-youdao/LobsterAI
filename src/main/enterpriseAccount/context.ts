import {
  EnterpriseAccountMode,
  EnterpriseAccountRequestHeader,
  EnterpriseAccountStoreKey,
  EnterpriseApiErrorCode,
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
  EnterpriseQuotaRequestType,
} from '../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContext,
  EnterpriseAccountContextResult,
  EnterpriseAccountIdentitiesResult,
  EnterpriseAccountIdentity,
  EnterpriseAccountPermissions,
  EnterpriseCreditPool,
  EnterpriseMemberQuota,
  EnterpriseQuotaRequestResult,
} from '../../shared/enterpriseAccount/types';
import type { SqliteStore } from '../sqliteStore';

type JsonRecord = Record<string, unknown>;

export interface EnterpriseAccountContextApiDeps {
  getServerBaseUrl: () => string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  store: SqliteStore;
  isRequestCurrent?: () => boolean;
  onAccountModeMismatch?: () => void;
  onMembershipRevoked?: () => void;
  requestTimeoutMs?: number;
}

export interface EnterpriseAccountIdentitiesApiDeps {
  getServerBaseUrl: () => string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  isRequestCurrent?: () => boolean;
  requestTimeoutMs?: number;
}

export type EnterpriseQuotaRequestApiDeps = EnterpriseAccountIdentitiesApiDeps;

const DEFAULT_ENTERPRISE_CONTEXT_REQUEST_TIMEOUT_MS = 10_000;

function resolveRequestTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ENTERPRISE_CONTEXT_REQUEST_TIMEOUT_MS;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTimestamp(value: unknown): string | null {
  const timestamp = readString(value);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function readEnterpriseId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function readRole(value: unknown): EnterpriseAccountContext['role'] | null {
  const normalized = readString(value).toLowerCase();
  if (normalized === EnterpriseMemberRole.SuperAdmin) {
    return EnterpriseMemberRole.SuperAdmin;
  }
  if (normalized === EnterpriseMemberRole.Member) {
    return EnterpriseMemberRole.Member;
  }
  return null;
}

function readPermissions(
  value: unknown,
  role: EnterpriseAccountContext['role'],
): EnterpriseAccountPermissions {
  const record = isRecord(value) ? value : {};
  const isSuperAdmin = role === EnterpriseMemberRole.SuperAdmin;
  return {
    manageEnterprise: typeof record.manageEnterprise === 'boolean'
      ? record.manageEnterprise
      : isSuperAdmin,
    adjustMemberQuota: typeof record.adjustMemberQuota === 'boolean'
      ? record.adjustMemberQuota
      : isSuperAdmin,
    rechargeEnterprise: typeof record.rechargeEnterprise === 'boolean'
      ? record.rechargeEnterprise
      : isSuperAdmin,
  };
}

function readMemberQuota(value: unknown): EnterpriseMemberQuota {
  const record = isRecord(value) ? value : {};
  const refreshCycle = record.refreshCycle === 'natural_week'
    ? 'natural_week'
    : record.refreshCycle === 'natural_month'
      ? 'natural_month'
      : null;
  const periodStart = readTimestamp(record.periodStart);
  const periodEndExclusive = readTimestamp(record.periodEndExclusive);
  return {
    limit: readNonNegativeNumber(record.limit),
    used: readNonNegativeNumber(record.used),
    remaining: readNonNegativeNumber(record.remaining),
    ...(record.reserved != null ? { reserved: readNonNegativeNumber(record.reserved) } : {}),
    ...(refreshCycle ? { refreshCycle } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEndExclusive ? { periodEndExclusive } : {}),
  };
}

function readEnterprisePool(value: unknown): EnterpriseCreditPool {
  const record = isRecord(value) ? value : {};
  return {
    total: readNonNegativeNumber(record.total),
    used: readNonNegativeNumber(record.used),
    remaining: readNonNegativeNumber(record.remaining),
  };
}

function readQuotaStatus(value: unknown): EnterpriseAccountContext['quotaStatus'] {
  const record = isRecord(value) ? value : {};
  const normalizedReason = readString(record.reason);
  const reason = Object.values(EnterpriseQuotaReason).find(item => item === normalizedReason) ?? null;
  return {
    available: typeof record.available === 'boolean' ? record.available : reason === null,
    reason,
    errorCode: readInteger(record.errorCode),
  };
}

function findContextCandidate(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const directMode = readString(value.accountMode).toLowerCase();
  if (directMode === EnterpriseAccountMode.Personal) {
    return null;
  }
  if (
    value.enterpriseId != null
    && readString(value.enterpriseName)
    && readRole(value.role) !== null
  ) {
    return value;
  }

  for (const key of [
    'enterpriseContext',
    'accountContext',
    'organizationContext',
    'context',
    'user',
    'data',
  ]) {
    const candidate = findContextCandidate(value[key]);
    if (candidate) return candidate;
  }
  return directMode === EnterpriseAccountMode.Enterprise ? value : null;
}

export function readAccountMode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = readString(value.accountMode).toLowerCase();
  if (direct) return direct;
  for (const key of ['enterpriseContext', 'accountContext', 'organizationContext', 'context', 'user', 'data']) {
    const nested = readAccountMode(value[key]);
    if (nested) return nested;
  }
  return null;
}

export function normalizeEnterpriseAccountContext(
  value: unknown,
): EnterpriseAccountContext | null {
  const candidate = findContextCandidate(value);
  if (!candidate) return null;

  const enterpriseId = readEnterpriseId(candidate.enterpriseId);
  const memberId = readEnterpriseId(candidate.memberId);
  const enterpriseName = readString(candidate.enterpriseName);
  const role = readRole(candidate.role);
  if (enterpriseId === null || memberId === null || !enterpriseName || role === null) {
    return null;
  }

  return {
    accountMode: EnterpriseAccountMode.Enterprise,
    enterpriseId,
    memberId,
    enterpriseName,
    role,
    permissions: readPermissions(candidate.permissions, role),
    memberQuota: readMemberQuota(candidate.memberQuota),
    enterprisePool: readEnterprisePool(candidate.enterprisePool),
    quotaStatus: readQuotaStatus(candidate.quotaStatus),
  };
}

export function normalizeEnterpriseAccountIdentities(
  value: unknown,
): EnterpriseAccountIdentity[] {
  if (!isRecord(value) || !Array.isArray(value.enterprises)) return [];

  return value.enterprises.flatMap((item): EnterpriseAccountIdentity[] => {
    if (!isRecord(item)) return [];
    const enterpriseId = readEnterpriseId(item.enterpriseId);
    const enterpriseName = readString(item.enterpriseName);
    const role = readRole(item.role);
    if (enterpriseId === null || !enterpriseName || role === null) return [];
    return [{ enterpriseId, enterpriseName, role }];
  });
}

export function getPersistedEnterpriseAccountContext(
  store: SqliteStore,
): EnterpriseAccountContext | null {
  try {
    const persisted = store.get<unknown>(EnterpriseAccountStoreKey.Context);
    return normalizeEnterpriseAccountContext(persisted);
  } catch (error) {
    console.warn('[EnterpriseAccount] failed to read persisted account context', error);
    return null;
  }
}

export function persistEnterpriseAccountContext(
  store: SqliteStore,
  context: EnterpriseAccountContext,
): void {
  store.set(EnterpriseAccountStoreKey.Context, context);
}

export function clearEnterpriseAccountContext(store: SqliteStore): void {
  store.delete(EnterpriseAccountStoreKey.Context);
}

export function buildEnterpriseAccountRequestHeaders(
  context: EnterpriseAccountContext | null,
): Record<string, string> {
  if (!context) return {};
  return {
    [EnterpriseAccountRequestHeader.AccountMode]: context.accountMode,
    [EnterpriseAccountRequestHeader.EnterpriseId]: String(context.enterpriseId),
  };
}

export async function fetchEnterpriseAccountContext(
  deps: EnterpriseAccountContextApiDeps,
): Promise<EnterpriseAccountContextResult> {
  const url = `${deps.getServerBaseUrl()}/api/enterprise/context`;
  const requestTimeoutMs = resolveRequestTimeoutMs(deps.requestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    console.debug('[EnterpriseAccount] refreshing account context');
    const response = await deps.fetchWithAuth(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const rawBody = await response.json() as unknown;
    const body = isRecord(rawBody) ? rawBody : {};
    const code = readInteger(body.code);
    const message = readString(body.message);

    if (deps.isRequestCurrent?.() === false) {
      console.debug('[EnterpriseAccount] discarded context response after auth state changed');
      return {
        success: false,
        context: getPersistedEnterpriseAccountContext(deps.store),
        error: 'Authentication state changed during enterprise context refresh',
      };
    }

    if (!response.ok || code !== 0) {
      if (
        code === EnterpriseApiErrorCode.NotFound
        || code === EnterpriseApiErrorCode.NotMember
        || code === EnterpriseApiErrorCode.AccountModeMismatch
      ) {
        if (code === EnterpriseApiErrorCode.AccountModeMismatch) {
          deps.onAccountModeMismatch?.();
        }
        if (code === EnterpriseApiErrorCode.NotMember) {
          deps.onMembershipRevoked?.();
        }
        clearEnterpriseAccountContext(deps.store);
        console.log(`[EnterpriseAccount] cleared stale account context after server code ${code}`);
      } else {
        console.warn(`[EnterpriseAccount] context refresh rejected (HTTP ${response.status}, code ${code ?? 'unknown'})`);
      }
      return {
        success: false,
        context: getPersistedEnterpriseAccountContext(deps.store),
        error: message || `HTTP ${response.status}`,
      };
    }

    const context = normalizeEnterpriseAccountContext(body.data);
    if (context) {
      persistEnterpriseAccountContext(deps.store, context);
      console.debug(`[EnterpriseAccount] refreshed context for enterprise ${context.enterpriseId} with role ${context.role}`);
    } else if (readAccountMode(body.data) === EnterpriseAccountMode.Enterprise) {
      console.warn('[EnterpriseAccount] rejected incomplete enterprise account context; preserving the last valid context');
      return {
        success: false,
        context: getPersistedEnterpriseAccountContext(deps.store),
        error: 'Enterprise account context response was incomplete',
      };
    } else {
      clearEnterpriseAccountContext(deps.store);
      console.debug('[EnterpriseAccount] refreshed personal account context');
    }
    return { success: true, context };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    console.warn(
      timedOut
        ? `[EnterpriseAccount] context refresh timed out after ${requestTimeoutMs}ms`
        : '[EnterpriseAccount] context refresh failed',
      error,
    );
    return {
      success: false,
      context: getPersistedEnterpriseAccountContext(deps.store),
      error: timedOut
        ? 'Enterprise account context request timed out'
        : error instanceof Error
          ? error.message
          : 'Failed to load enterprise account context',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchEnterpriseAccountIdentities(
  deps: EnterpriseAccountIdentitiesApiDeps,
): Promise<EnterpriseAccountIdentitiesResult> {
  const url = `${deps.getServerBaseUrl()}/api/enterprise/identities`;
  const requestTimeoutMs = resolveRequestTimeoutMs(deps.requestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    console.debug('[EnterpriseAccount] refreshing enterprise identities');
    const response = await deps.fetchWithAuth(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const rawBody = await response.json() as unknown;
    const body = isRecord(rawBody) ? rawBody : {};
    const code = readInteger(body.code);
    const message = readString(body.message);

    if (deps.isRequestCurrent?.() === false) {
      return {
        success: false,
        identities: [],
        error: 'Authentication state changed during enterprise identity refresh',
      };
    }
    if (!response.ok || code !== 0) {
      console.warn(`[EnterpriseAccount] identity refresh rejected (HTTP ${response.status}, code ${code ?? 'unknown'})`);
      return {
        success: false,
        identities: [],
        error: message || `HTTP ${response.status}`,
      };
    }
    const identities = normalizeEnterpriseAccountIdentities(body.data);
    console.debug(`[EnterpriseAccount] refreshed ${identities.length} enterprise identities`);
    return {
      success: true,
      identities,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    console.warn(
      timedOut
        ? `[EnterpriseAccount] identity refresh timed out after ${requestTimeoutMs}ms`
        : '[EnterpriseAccount] identity refresh failed',
      error,
    );
    return {
      success: false,
      identities: [],
      error: timedOut
        ? 'Enterprise account identities request timed out'
        : error instanceof Error
          ? error.message
          : 'Failed to load enterprise account identities',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestEnterpriseQuotaIncrease(
  deps: EnterpriseQuotaRequestApiDeps,
  enterpriseId: number,
  requestType: EnterpriseQuotaRequestType,
): Promise<EnterpriseQuotaRequestResult> {
  const normalizedEnterpriseId = readEnterpriseId(enterpriseId);
  if (normalizedEnterpriseId === null) {
    console.warn('[EnterpriseAccount] rejected quota request with invalid enterprise id');
    return { success: false, error: 'Invalid enterprise ID' };
  }
  if (!Object.values(EnterpriseQuotaRequestType).some(type => type === requestType)) {
    console.warn('[EnterpriseAccount] rejected quota request with invalid request type');
    return { success: false, error: 'Invalid enterprise quota request type' };
  }

  const url = `${deps.getServerBaseUrl()}/api/enterprise/${normalizedEnterpriseId}/quota-requests`;
  const requestTimeoutMs = resolveRequestTimeoutMs(deps.requestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    console.debug(`[EnterpriseAccount] submitting ${requestType} quota request for enterprise ${normalizedEnterpriseId}`);
    const response = await deps.fetchWithAuth(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestType }),
      signal: controller.signal,
    });
    const rawBody = await response.json() as unknown;
    const body = isRecord(rawBody) ? rawBody : {};
    const code = readInteger(body.code);
    const message = readString(body.message);
    const data = isRecord(body.data) ? body.data : {};
    if (deps.isRequestCurrent?.() === false) {
      console.debug('[EnterpriseAccount] discarded quota request response after auth state changed');
      return { success: false, error: 'Authentication state changed during quota request' };
    }
    if (!response.ok || code !== 0) {
      console.warn(`[EnterpriseAccount] quota request rejected (HTTP ${response.status}, code ${code ?? 'unknown'})`);
      return { success: false, error: message || `HTTP ${response.status}` };
    }
    const result: EnterpriseQuotaRequestResult = {
      success: true,
      requestId: readEnterpriseId(data.requestId) ?? undefined,
      requestType,
      status: 'pending',
      created: data.created === true,
    };
    console.debug(`[EnterpriseAccount] quota request accepted (request ${result.requestId ?? 'unknown'}, created ${result.created === true})`);
    return result;
  } catch (error) {
    const timedOut = controller.signal.aborted;
    console.warn(
      timedOut
        ? `[EnterpriseAccount] quota request timed out after ${requestTimeoutMs}ms`
        : '[EnterpriseAccount] quota request failed',
      error,
    );
    return {
      success: false,
      error: timedOut
        ? 'Enterprise quota request timed out'
        : error instanceof Error
          ? error.message
          : 'Failed to submit enterprise quota request',
    };
  } finally {
    clearTimeout(timeout);
  }
}
