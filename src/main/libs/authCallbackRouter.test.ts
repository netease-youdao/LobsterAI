import { describe, expect, test } from 'vitest';

import { AuthIpcChannel } from '../../shared/auth/constants';
import { AuthCallbackRouter, type AuthCallbackTarget } from './authCallbackRouter';

function createTarget(): {
  target: AuthCallbackTarget;
  sent: Array<{ channel: string; payload: { code: string } }>;
} {
  const sent: Array<{ channel: string; payload: { code: string } }> = [];
  return {
    sent,
    target: {
      isDestroyed: () => false,
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
    },
  };
}

describe('AuthCallbackRouter', () => {
  test('cancel discards buffered and late callbacks until the next login', () => {
    const { target, sent } = createTarget();
    let allowed = true;
    const router = new AuthCallbackRouter({ getTarget: () => target, acceptsCallback: () => allowed });
    router.handleAuthCode('buffered');
    allowed = false;
    router.clearPending();
    expect(router.markListenerReadyAndConsumePending()).toBeNull();
    router.handleDeepLink('lobsterai://auth/callback?code=late');
    expect(sent).toEqual([]);
    allowed = true;
    router.handleAuthCode('new-attempt');
    expect(sent).toEqual([{ channel: AuthIpcChannel.Callback, payload: { code: 'new-attempt' } }]);
  });

  test('sends callback immediately when renderer listener is ready', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    expect(router.markListenerReadyAndConsumePending()).toBeNull();
    router.handleDeepLink('lobsterai://auth/callback?code=ready-code');

    expect(sent).toEqual([
      { channel: AuthIpcChannel.Callback, payload: { code: 'ready-code' } },
    ]);
  });

  test('buffers callback until renderer listener becomes ready', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    router.handleDeepLink('lobsterai://auth/callback?code=pending-code');

    expect(sent).toEqual([]);
    expect(router.markListenerReadyAndConsumePending()).toBe('pending-code');
    expect(router.markListenerReadyAndConsumePending()).toBeNull();
  });

  test('direct auth code delivery uses the same ready listener path', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    router.markListenerReadyAndConsumePending();
    router.handleAuthCode('local-code');

    expect(sent).toEqual([
      { channel: AuthIpcChannel.Callback, payload: { code: 'local-code' } },
    ]);
  });

  test('direct auth code delivery buffers before renderer listener is ready', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    router.handleAuthCode('local-pending-code');

    expect(sent).toEqual([]);
    expect(router.markListenerReadyAndConsumePending()).toBe('local-pending-code');
  });

  test('keeps renderer listener ready for child frame artifact loads', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    router.markListenerReadyAndConsumePending();
    router.handleNavigationStarted({ isMainFrame: false, isInPlace: false });
    router.handleDeepLink('lobsterai://auth/callback?code=iframe-code');

    expect(sent).toEqual([
      { channel: AuthIpcChannel.Callback, payload: { code: 'iframe-code' } },
    ]);
  });

  test('marks renderer unavailable for main frame document navigation', () => {
    const { target, sent } = createTarget();
    const router = new AuthCallbackRouter({ getTarget: () => target });

    router.markListenerReadyAndConsumePending();
    router.handleNavigationStarted({ isMainFrame: true, isInPlace: false });
    router.handleDeepLink('lobsterai://auth/callback?code=reload-code');

    expect(sent).toEqual([]);
    expect(router.markListenerReadyAndConsumePending()).toBe('reload-code');
  });
});
