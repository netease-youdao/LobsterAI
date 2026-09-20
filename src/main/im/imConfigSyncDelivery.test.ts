import { expect, test, vi } from 'vitest';

import { getIMConfigSaveStatus, IMConfigSaveStatus } from '../../shared/im/configSync';
import { ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';
import { syncIMConfigDelivery } from './imConfigSyncDelivery';

test.each([ConfigDeliveryState.Pending, ConfigDeliveryState.RestartRequired])(
  'preserves %s receipt and shows saved pending without asking for a process restart', async deliveryState => {
    const sync = vi.fn().mockResolvedValue({ success: false, deliveryState, mutationId: 'mutation-1',
      desiredRevision: 'desired', persistedRevision: 'persisted', appliedRevision: 'previous', gatewayGeneration: 2 });
    const result = await syncIMConfigDelivery(sync, 'im-fingerprint');
    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith({ reason: 'im-config-change', imConfigRestartFingerprint: 'im-fingerprint' });
    expect(result).toEqual({ success: true, applied: false, pending: true, deliveryState,
      mutationId: 'mutation-1', desiredRevision: 'desired', persistedRevision: 'persisted', appliedRevision: 'previous', gatewayGeneration: 2 });
    expect(getIMConfigSaveStatus(result)).toBe(IMConfigSaveStatus.Pending);
  },
);

test('only a confirmed applied receipt is presented as applied', async () => {
  const result = await syncIMConfigDelivery(async () => ({ success: true, deliveryState: ConfigDeliveryState.Applied }), 'same-account');
  expect(result).toMatchObject({ success: true, applied: true, pending: false });
  expect(getIMConfigSaveStatus(result)).toBe(IMConfigSaveStatus.Saved);
  expect(getIMConfigSaveStatus(await syncIMConfigDelivery(async () => ({ success: true }), 'unknown')))
    .toBe(IMConfigSaveStatus.Pending);
});

test('rejected delivery and real exceptions are not converted to success', async () => {
  const result = await syncIMConfigDelivery(async () => ({ success: false, deliveryState: ConfigDeliveryState.Rejected,
    error: 'Invalid channel configuration' }), 'invalid');
  expect(result).toMatchObject({ success: false, applied: false, pending: false, error: 'Invalid channel configuration' });
  expect(getIMConfigSaveStatus(result)).toBe(IMConfigSaveStatus.Rejected);
  await expect(syncIMConfigDelivery(async () => { throw new Error('IPC failed'); }, 'failed')).rejects.toThrow('IPC failed');
  expect(getIMConfigSaveStatus({ success: false, error: 'IPC failed' })).toBe(IMConfigSaveStatus.Rejected);
});
