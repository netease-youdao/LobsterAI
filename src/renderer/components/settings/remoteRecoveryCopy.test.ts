import { describe, expect, test } from 'vitest';

import { RemoteSyncRecoveryState } from '../../../shared/remote/recovery';
import { recoveryNextProbeText, recoveryStatusLabel } from './remoteRecoveryCopy';

describe('bounded recovery presentation', () => {
  test.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001])('does not render an invalid retry date: %s', nextProbeAt => {
    expect(recoveryNextProbeText({ state: RemoteSyncRecoveryState.Waiting, nextProbeAt }, 100)).toBeNull();
  });
  test('does not present an expired deadline or an unknown status as success', () => {
    expect(recoveryNextProbeText({ state: RemoteSyncRecoveryState.Waiting, nextProbeAt: 100 }, 100)).toBeNull();
    expect(recoveryStatusLabel({ state: 'future' as RemoteSyncRecoveryState })).toBeNull();
  });
});
