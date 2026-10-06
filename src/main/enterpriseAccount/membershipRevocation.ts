import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import type { MediaAccountScope } from '../mediaAccountIsolation';

export const EnterpriseMembershipRevocationSource = {
  EnterpriseContext: 'enterprise_context',
  JsonApi: 'json_api',
  LlmSse: 'llm_sse',
  Models: 'models',
  Profile: 'profile',
  Quota: 'quota',
  Refresh: 'refresh',
} as const;

export type EnterpriseMembershipRevocationSource =
  typeof EnterpriseMembershipRevocationSource[keyof typeof EnterpriseMembershipRevocationSource];

export interface EnterpriseAuthSessionSnapshot extends MediaAccountScope {
  enterpriseId: number;
}

export interface EnterpriseMembershipRevocationEvent {
  code: number;
  source: EnterpriseMembershipRevocationSource;
  requestSession: EnterpriseAuthSessionSnapshot | null;
}

interface EnterpriseMembershipRevocationHandlerDeps {
  getCurrentSession: () => EnterpriseAuthSessionSnapshot | null;
  invalidateCurrentSession: (event: EnterpriseMembershipRevocationEvent) => void;
}

const isPositiveInteger = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0
);

export const createEnterpriseAuthSessionSnapshot = (
  accountScope: MediaAccountScope | null,
  enterpriseId: unknown,
): EnterpriseAuthSessionSnapshot | null => {
  if (
    !accountScope
    || !isPositiveInteger(enterpriseId)
    || !accountScope.ownerAccountKey.startsWith('enterprise:')
    || !accountScope.ownerAccountKey.endsWith(`:${enterpriseId}`)
  ) {
    return null;
  }

  return {
    ...accountScope,
    enterpriseId,
  };
};

const isSameEnterpriseAuthSession = (
  expected: EnterpriseAuthSessionSnapshot | null,
  current: EnterpriseAuthSessionSnapshot | null,
): boolean => (
  expected !== null
  && current !== null
  && expected.enterpriseId === current.enterpriseId
  && expected.ownerAccountKey === current.ownerAccountKey
  && expected.accountGeneration === current.accountGeneration
);

const getEnterpriseAuthSessionKey = (session: EnterpriseAuthSessionSnapshot): string => (
  `${session.ownerAccountKey}:${session.enterpriseId}:${session.accountGeneration}`
);

export const createEnterpriseMembershipRevocationHandler = (
  deps: EnterpriseMembershipRevocationHandlerDeps,
): ((event: EnterpriseMembershipRevocationEvent) => boolean) => {
  let invalidatedSessionKey: string | null = null;

  return (event): boolean => {
    if (event.code !== EnterpriseApiErrorCode.NotMember) {
      return false;
    }

    const currentSession = deps.getCurrentSession();
    if (!isSameEnterpriseAuthSession(event.requestSession, currentSession)) {
      return false;
    }

    const sessionKey = getEnterpriseAuthSessionKey(currentSession);
    if (invalidatedSessionKey === sessionKey) {
      return false;
    }

    invalidatedSessionKey = sessionKey;
    try {
      deps.invalidateCurrentSession(event);
      return true;
    } catch (error) {
      invalidatedSessionKey = null;
      throw error;
    }
  };
};

export const readEnterpriseApiErrorCode = (body: unknown): number | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const code = (body as Record<string, unknown>).code;
  if (typeof code === 'number' && Number.isSafeInteger(code)) {
    return code;
  }
  if (typeof code === 'string' && /^-?\d+$/.test(code.trim())) {
    const parsed = Number(code.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

export const resolveEnterpriseMembershipRevocationSource = (
  requestUrl: string,
): EnterpriseMembershipRevocationSource => {
  let pathname = requestUrl;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    pathname = requestUrl.split('?')[0] ?? requestUrl;
  }

  if (pathname === '/api/enterprise/context') {
    return EnterpriseMembershipRevocationSource.EnterpriseContext;
  }
  if (pathname.includes('/api/user/profile')) {
    return EnterpriseMembershipRevocationSource.Profile;
  }
  if (pathname.includes('/api/user/quota')) {
    return EnterpriseMembershipRevocationSource.Quota;
  }
  if (pathname.includes('/api/models/') || pathname.endsWith('/models')) {
    return EnterpriseMembershipRevocationSource.Models;
  }
  return EnterpriseMembershipRevocationSource.JsonApi;
};
