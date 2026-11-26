import { describe, expect, it, vi } from 'vitest';

import { RemoteSettingsError } from '../../shared/remote/constants';
import { RemoteApiError } from './remoteBridge';
import { withRemoteConnectionAccount } from './remoteConnectionIpc';

describe('connection management IPC identity fence', () => {
  it('rejects a queued mutation from a previous account epoch before invoking it', async () => {
    const action = vi.fn();
    await expect(withRemoteConnectionAccount({ expectedAccountEpoch: 'old' }, { getAccountEpoch: () => 'new',
      getOwner: () => ({ userId: '1', scopeKey: 'personal' }) }, action)).rejects.toThrow(RemoteSettingsError.AccountChanged);
    expect(action).not.toHaveBeenCalled();
  });
  it('rejects an old result even when a user logs back into the same account', async () => {
    let epoch = 'first';
    await expect(withRemoteConnectionAccount({ expectedAccountEpoch: epoch }, { getAccountEpoch: () => epoch,
      getOwner: () => ({ userId: '1', scopeKey: 'personal' }) }, async () => { epoch = 'second'; return 'private'; }))
      .rejects.toThrow(RemoteSettingsError.AccountChanged);
  });
  it('preserves stable error codes across Electron Error serialization without exposing error payloads', async () => {
    await expect(withRemoteConnectionAccount({}, { getAccountEpoch: () => 'epoch', getOwner: () => ({ userId: '1', scopeKey: 'personal' }) },
      async () => { throw new RemoteApiError(47120, 'Connection version conflict', { secret: 'hidden' }); }))
      .rejects.toThrow('47120: Connection version conflict');
  });
});
