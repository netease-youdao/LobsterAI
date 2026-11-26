import { expect, test, vi } from 'vitest';

import { RemoteConnectionReleaseState, RemoteDeviceConnectionState } from '../../shared/remote/connections';
import { RemoteConnectionClient } from './remoteConnectionClient';

test('starts a new receipt deduplication context after account or mode reset', async () => {
  const retry = vi.fn();
  const client = new RemoteConnectionClient({
    guard: () => () => undefined,
    ensure: async () => true,
    deviceId: () => 'device',
    observe: vi.fn(),
    retry,
    request: async () => ({ requestId: 'same-id', deviceId: 'device', connectionVersion: '1',
      connectionState: RemoteDeviceConnectionState.Removed, releaseState: RemoteConnectionReleaseState.Released, nextAction: '' }),
  });
  await client.operation('same-id');
  await client.operation('same-id');
  expect(retry).toHaveBeenCalledTimes(1);
  client.reset();
  await client.operation('same-id');
  expect(retry).toHaveBeenCalledTimes(2);
});
