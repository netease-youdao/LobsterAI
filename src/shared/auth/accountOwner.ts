import { EnterpriseAccountMode } from '../enterpriseAccount/constants';

export interface AccountOwnerUser {
  userId?: unknown;
  id?: unknown;
  yid?: unknown;
  accountMode?: unknown;
}

export const AccountOwnerKeyPrefix = {
  Personal: 'personal:',
  Enterprise: 'enterprise:',
} as const;

const normalizeAccountOwnerPart = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
};

export const resolveAccountOwnerUserId = (
  user: AccountOwnerUser | null | undefined,
): string | null => (
  normalizeAccountOwnerPart(user?.userId)
  ?? normalizeAccountOwnerPart(user?.id)
  ?? normalizeAccountOwnerPart(user?.yid)
);

export const createAccountOwnerKey = (input: {
  user: AccountOwnerUser | null | undefined;
  enterpriseId?: number | null;
}): string | null => {
  const userId = resolveAccountOwnerUserId(input.user);
  if (!userId) return null;
  if (typeof input.enterpriseId === 'number' && Number.isFinite(input.enterpriseId)) {
    return `${AccountOwnerKeyPrefix.Enterprise}${userId}:${input.enterpriseId}`;
  }
  const accountMode = typeof input.user?.accountMode === 'string'
    ? input.user.accountMode.trim().toLowerCase()
    : '';
  return accountMode === EnterpriseAccountMode.Enterprise
    ? null
    : `${AccountOwnerKeyPrefix.Personal}${userId}`;
};

export const isEnterpriseAccountOwnerKey = (
  ownerAccountKey: string | null | undefined,
): boolean => ownerAccountKey?.startsWith(AccountOwnerKeyPrefix.Enterprise) === true;
