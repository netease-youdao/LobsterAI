import { expect, test, vi } from 'vitest';

import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';
import { requestOpenClawIdleStop } from './openclawIdleRestart';
const acquired = { state: 'acquired', leaseId: 'lease', instanceId: 'process', targetRevision: 'revision' };
test.each(['busy', 'unknown', 'expired'])('does not stop when the runtime returns %s', async state => {
  const request = vi.fn().mockResolvedValue({ restartLease: { state } });
  expect(await requestOpenClawIdleStop({ request } as OpenClawConfigRpcClient, 'revision', () => true)).toBe('not-requested');
  expect(request).toHaveBeenCalledTimes(1);
});
test('commits only the acquired process/revision lease', async () => {
  const request = vi.fn().mockResolvedValueOnce({ restartLease: acquired })
    .mockResolvedValueOnce({ restartLease: { ...acquired, state: 'committed' } });
  expect(await requestOpenClawIdleStop({ request } as OpenClawConfigRpcClient, 'revision', () => true)).toBe('committed');
  expect(request.mock.calls[1][1]).toEqual({ raw: '{}', restartLeaseAction: 'commit', restartLeaseId: 'lease',
    restartLeaseInstanceId: 'process', restartTargetRevision: 'revision' });
});
test('shutdown or changed generation after acquire releases admission without stopping', async () => {
  const request = vi.fn().mockResolvedValue({ restartLease: acquired });
  expect(await requestOpenClawIdleStop({ request } as OpenClawConfigRpcClient, 'revision', () => false)).toBe('not-requested');
  expect(request.mock.calls[1][1].restartLeaseAction).toBe('release');
});
test('commit timeout remains uncertain and never resubmits', async () => {
  const request = vi.fn().mockResolvedValueOnce({ restartLease: acquired }).mockRejectedValueOnce(new Error('timeout'));
  expect(await requestOpenClawIdleStop({ request } as OpenClawConfigRpcClient, 'revision', () => true)).toBe('uncertain');
  expect(request).toHaveBeenCalledTimes(2);
});
