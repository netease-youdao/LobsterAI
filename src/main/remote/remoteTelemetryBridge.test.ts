import { describe, expect, test } from 'vitest';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { remoteRequestTelemetryFailureStage, remoteRequestTelemetryOutcome } from './remoteTelemetryBridge';

describe('remote request failure attribution', () => {
  test('separates token absence and refresh failure from the business HTTP transport', () => {
    for (const error of [new AuthSessionRequestError(AuthSessionStatus.Unauthenticated, 'private message'),
      new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'private message', { failureKind: AuthRefreshFailureKind.Network })]) {
      expect(remoteRequestTelemetryOutcome(error, 'transport')).toBe('preflight_failed');
      expect(remoteRequestTelemetryFailureStage(error, 'transport')).toBe('auth');
    }
    const originalError = new TypeError('private URL');
    const transport = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'private message', { failureKind: AuthRefreshFailureKind.Network, originalError });
    expect(remoteRequestTelemetryFailureStage(transport, 'transport')).toBe('transport');
  });
});
