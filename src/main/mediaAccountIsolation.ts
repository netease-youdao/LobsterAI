export interface MediaAccountScope {
  ownerAccountKey: string;
  accountGeneration: number;
}

export type AuthenticatedFetch = (url: string, options?: RequestInit) => Promise<Response>;

export interface AuthStateSnapshot {
  accountGeneration: number;
  accessToken: string;
  refreshToken: string;
}

export interface AuthExchangeIntentSnapshot {
  intentId: number;
  accountGeneration: number;
  accessToken: string | null;
  refreshToken: string | null;
}

export interface AccountBoundValue<T> extends MediaAccountScope {
  value: T;
}

export const isMediaAccountScopeCurrent = (
  expected: MediaAccountScope,
  current: MediaAccountScope | null,
): boolean => (
  current?.ownerAccountKey === expected.ownerAccountKey
  && current.accountGeneration === expected.accountGeneration
);

export const isMediaAccountScopeSnapshotCurrent = (
  expected: MediaAccountScope | null,
  current: MediaAccountScope | null,
): boolean => (
  expected === null
    ? current === null
    : isMediaAccountScopeCurrent(expected, current)
);

export const createAccountScopedFetch = (
  expected: MediaAccountScope,
  getCurrentScope: () => MediaAccountScope | null,
  fetchWithAuth: AuthenticatedFetch,
): AuthenticatedFetch => async (url, options) => {
  if (!isMediaAccountScopeCurrent(expected, getCurrentScope())) {
    throw new Error('Account changed before the publishing request was sent');
  }
  const response = await fetchWithAuth(url, options);
  if (!isMediaAccountScopeCurrent(expected, getCurrentScope())) {
    throw new Error('Account changed while the publishing request was running');
  }
  return response;
};

export const bindAccountValue = <T>(
  value: T,
  scope: MediaAccountScope,
): AccountBoundValue<T> => ({
  ...scope,
  value,
});

export const resolveAccountBoundValue = <T>(
  bound: AccountBoundValue<T> | undefined,
  currentScope: MediaAccountScope | null,
): T | undefined => (
  bound && isMediaAccountScopeCurrent(bound, currentScope)
    ? bound.value
    : undefined
);

export const rebindMediaAccountScope = (
  ownerAccountKey: string,
  current: MediaAccountScope | null,
): MediaAccountScope | null => (
  current?.ownerAccountKey === ownerAccountKey
    ? {
      ownerAccountKey,
      accountGeneration: current.accountGeneration,
    }
    : null
);

export const canAccessTrackedMediaTask = (
  trackedOwnerAccountKey: string | null | undefined,
  requestScope: MediaAccountScope | null,
): boolean => (
  trackedOwnerAccountKey != null
  && requestScope?.ownerAccountKey === trackedOwnerAccountKey
);

export const rememberMediaTaskOwnerAliases = (
  registry: Map<string, string>,
  ownerAccountKey: string,
  taskIds: readonly unknown[],
  maxAliases = 2_000,
): void => {
  for (const rawTaskId of taskIds) {
    if (rawTaskId === null || rawTaskId === undefined) continue;
    const taskId = String(rawTaskId).trim();
    if (!taskId) continue;
    registry.delete(taskId);
    registry.set(taskId, ownerAccountKey);
  }

  while (registry.size > maxAliases) {
    const oldestTaskId = registry.keys().next().value as string | undefined;
    if (!oldestTaskId) break;
    registry.delete(oldestTaskId);
  }
};

export const clearMediaTaskOwnerAliasesForOwner = (
  registry: Map<string, string>,
  ownerAccountKey: string,
): void => {
  for (const [taskId, trackedOwnerAccountKey] of registry) {
    if (trackedOwnerAccountKey === ownerAccountKey) {
      registry.delete(taskId);
    }
  }
};

export const shouldRemoveMediaTaskAfterPoll = (
  responseScope: MediaAccountScope,
  currentScope: MediaAccountScope | null,
  terminal: boolean,
): boolean => (
  terminal && isMediaAccountScopeCurrent(responseScope, currentScope)
);

export const isAuthStateSnapshotCurrent = (
  expected: AuthStateSnapshot,
  currentGeneration: number,
  currentTokens: { accessToken: string; refreshToken: string } | null,
): boolean => (
  currentGeneration === expected.accountGeneration
  && currentTokens?.accessToken === expected.accessToken
  && currentTokens.refreshToken === expected.refreshToken
);

export const isAuthExchangeIntentCurrent = (
  expected: AuthExchangeIntentSnapshot,
  activeIntentId: number | null,
  currentGeneration: number,
  currentTokens: { accessToken: string; refreshToken: string } | null,
): boolean => (
  activeIntentId === expected.intentId
  && currentGeneration === expected.accountGeneration
  && currentTokens?.accessToken === (expected.accessToken ?? undefined)
  && currentTokens?.refreshToken === (expected.refreshToken ?? undefined)
  && (
    currentTokens !== null
    || (expected.accessToken === null && expected.refreshToken === null)
  )
);
