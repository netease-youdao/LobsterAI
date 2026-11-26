import { describe, expect, test } from 'vitest';

import {
  AuthAccessPolicy,
  type AuthAccessState,
  AuthGateReason,
  AuthIpcChannel,
} from '../../../shared/auth/constants';
import { registerAuthGateHandlers } from './handlers';

describe('registerAuthGateHandlers', () => {
  test('registers auth:getAccessState and returns current auth access state', () => {
    const registered = new Map<string, () => unknown>();
    const currentState: AuthAccessState = {
      policy: AuthAccessPolicy.LoginRequired,
      loginRequired: true,
      blocked: true,
      reason: AuthGateReason.FirstRun,
    };

    registerAuthGateHandlers({
      ipcMain: {
        handle: (channel, handler) => {
          registered.set(channel, handler as () => unknown);
        },
      },
      getAuthAccessState: () => currentState,
    });

    const handler = registered.get(AuthIpcChannel.GetAccessState);
    expect(handler).toBeDefined();
    expect(handler?.()).toEqual(currentState);
  });
});
