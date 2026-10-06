import { describe, expect, test, vi } from 'vitest';

import {
  bindAccountValue,
  canAccessTrackedMediaTask,
  clearMediaTaskOwnerAliasesForOwner,
  createAccountScopedFetch,
  isAuthExchangeIntentCurrent,
  isAuthStateSnapshotCurrent,
  isMediaAccountScopeCurrent,
  isMediaAccountScopeSnapshotCurrent,
  type MediaAccountScope,
  rebindMediaAccountScope,
  rememberMediaTaskOwnerAliases,
  resolveAccountBoundValue,
  shouldRemoveMediaTaskAfterPoll,
} from './mediaAccountIsolation';

const enterpriseScope: MediaAccountScope = {
  ownerAccountKey: 'enterprise:6:1001',
  accountGeneration: 3,
};

describe('createAccountScopedFetch', () => {
  test('rejects before sending after an account switch', async () => {
    const fetchWithAuth = vi.fn();
    const scopedFetch = createAccountScopedFetch(
      enterpriseScope,
      () => ({ ...enterpriseScope, ownerAccountKey: 'enterprise:6:1002' }),
      fetchWithAuth,
    );

    await expect(scopedFetch('https://example.test')).rejects.toThrow('Account changed');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('isMediaAccountScopeCurrent', () => {
  test('accepts work only while both account owner and generation match', () => {
    expect(isMediaAccountScopeCurrent(enterpriseScope, { ...enterpriseScope })).toBe(true);
  });

  test('rejects a task after switching enterprise or auth generation', () => {
    expect(isMediaAccountScopeCurrent(enterpriseScope, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: 3,
    })).toBe(false);
    expect(isMediaAccountScopeCurrent(enterpriseScope, {
      ownerAccountKey: enterpriseScope.ownerAccountKey,
      accountGeneration: 4,
    })).toBe(false);
  });

  test('rejects work when there is no authenticated account', () => {
    expect(isMediaAccountScopeCurrent(enterpriseScope, null)).toBe(false);
  });

  test('treats logout-to-logout as stable but rejects login or account invalidation races', () => {
    expect(isMediaAccountScopeSnapshotCurrent(null, null)).toBe(true);
    expect(isMediaAccountScopeSnapshotCurrent(null, enterpriseScope)).toBe(false);
    expect(isMediaAccountScopeSnapshotCurrent(enterpriseScope, null)).toBe(false);
  });

  test('rebinds a paused task only after switching back to its owner', () => {
    expect(rebindMediaAccountScope(enterpriseScope.ownerAccountKey, {
      ownerAccountKey: enterpriseScope.ownerAccountKey,
      accountGeneration: 9,
    })).toEqual({
      ownerAccountKey: enterpriseScope.ownerAccountKey,
      accountGeneration: 9,
    });
    expect(rebindMediaAccountScope(enterpriseScope.ownerAccountKey, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: 9,
    })).toBeNull();
  });

  test('does not restore a selection bound to an earlier owner or auth generation', () => {
    const selection = bindAccountValue({ mode: 'image', modelId: 'image-a' }, enterpriseScope);

    expect(resolveAccountBoundValue(selection, enterpriseScope)).toEqual({
      mode: 'image',
      modelId: 'image-a',
    });
    expect(resolveAccountBoundValue(selection, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: enterpriseScope.accountGeneration,
    })).toBeUndefined();
    expect(resolveAccountBoundValue(selection, {
      ...enterpriseScope,
      accountGeneration: enterpriseScope.accountGeneration + 1,
    })).toBeUndefined();
  });
});

describe('canAccessTrackedMediaTask', () => {
  test('blocks status and cancel calls when a pending task belongs to another account', () => {
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, enterpriseScope)).toBe(true);
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: enterpriseScope.accountGeneration,
    })).toBe(false);
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, null)).toBe(false);
    expect(canAccessTrackedMediaTask(undefined, enterpriseScope)).toBe(false);
  });

  test('registers both internal and upstream task ids as explicit owner evidence', () => {
    const registry = new Map<string, string>();
    rememberMediaTaskOwnerAliases(
      registry,
      enterpriseScope.ownerAccountKey,
      [123, 'upstream-task-123'],
    );

    expect(registry.get('123')).toBe(enterpriseScope.ownerAccountKey);
    expect(registry.get('upstream-task-123')).toBe(enterpriseScope.ownerAccountKey);
    expect(registry.get('unknown-task')).toBeUndefined();
  });

  test('removes only aliases owned by the account being cleared', () => {
    const registry = new Map([
      ['task-a', enterpriseScope.ownerAccountKey],
      ['task-b', 'enterprise:6:1002'],
      ['task-c', enterpriseScope.ownerAccountKey],
    ]);

    clearMediaTaskOwnerAliasesForOwner(registry, enterpriseScope.ownerAccountKey);

    expect([...registry.entries()]).toEqual([
      ['task-b', 'enterprise:6:1002'],
    ]);
  });
});

describe('shouldRemoveMediaTaskAfterPoll', () => {
  test('keeps a tracker when the account switches during a terminal poll response', () => {
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: 4,
    }, true)).toBe(false);
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, null, true)).toBe(false);
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, enterpriseScope, true)).toBe(true);
  });
});

describe('isAuthStateSnapshotCurrent', () => {
  const snapshot = {
    accountGeneration: 7,
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
  };

  test('rejects late auth responses after account or token changes', () => {
    expect(isAuthStateSnapshotCurrent(snapshot, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(true);
    expect(isAuthStateSnapshotCurrent(snapshot, 8, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthStateSnapshotCurrent(snapshot, 7, {
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    })).toBe(false);
    expect(isAuthStateSnapshotCurrent(snapshot, 7, null)).toBe(false);
  });
});

describe('isAuthExchangeIntentCurrent', () => {
  test('allows only the latest request-start intent to commit', () => {
    const intent = {
      intentId: 4,
      accountGeneration: 7,
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    };

    expect(isAuthExchangeIntentCurrent(intent, 4, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(true);
    expect(isAuthExchangeIntentCurrent(intent, 5, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 4, 8, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 4, 7, null)).toBe(false);
  });

  test('invalidates a logged-out exchange when logout or another exchange starts', () => {
    const intent = {
      intentId: 1,
      accountGeneration: 0,
      accessToken: null,
      refreshToken: null,
    };

    expect(isAuthExchangeIntentCurrent(intent, 1, 0, null)).toBe(true);
    expect(isAuthExchangeIntentCurrent(intent, null, 1, null)).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 2, 0, null)).toBe(false);
  });
});
