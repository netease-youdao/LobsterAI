import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AuthCallbackTransport } from '../../shared/auth/constants';
import {
  AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY,
  AUTH_CALLBACK_TRANSPORT_PREFERENCE_TTL_MS,
  AuthLoginTransportPolicy,
  AuthLoginTransportSource,
  type AuthLoginTransportStore,
  parseAuthCallbackTransportPreference,
} from './authLoginTransport';

const NOW = Date.parse('2026-10-01T00:00:00Z');

function createStore(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const store: AuthLoginTransportStore = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key, value) => {
      values.set(key, value);
    },
    delete: key => {
      values.delete(key);
    },
  };
  return { store, values };
}

function createPolicy(initial: Record<string, unknown> = {}) {
  const { store, values } = createStore(initial);
  const getStore = vi.fn(() => store);
  const policy = new AuthLoginTransportPolicy({ getStore, now: () => NOW });
  return { policy, values, getStore };
}

const deepLinkPreference = {
  transport: AuthCallbackTransport.DeepLink,
  expiresAt: NOW + AUTH_CALLBACK_TRANSPORT_PREFERENCE_TTL_MS,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAuthCallbackTransportPreference', () => {
  test.each([
    ['missing value', undefined],
    ['unknown transport', { transport: 'carrier_pigeon', expiresAt: NOW + 1 }],
    ['missing expiry', { transport: AuthCallbackTransport.DeepLink }],
    ['expired preference', { transport: AuthCallbackTransport.DeepLink, expiresAt: NOW }],
  ])('ignores a %s', (_label, value) => {
    expect(parseAuthCallbackTransportPreference(value, NOW)).toBeNull();
  });

  test('accepts an unexpired preference', () => {
    expect(parseAuthCallbackTransportPreference(deepLinkPreference, NOW)).toEqual(deepLinkPreference);
  });
});

describe('AuthLoginTransportPolicy.resolve', () => {
  test('uses the loopback callback by default', () => {
    const { policy } = createPolicy();

    expect(policy.resolve(undefined)).toEqual({
      transport: AuthCallbackTransport.Loopback,
      source: AuthLoginTransportSource.Default,
    });
  });

  test('uses a remembered deep link preference', () => {
    const { policy } = createPolicy({ [AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY]: deepLinkPreference });

    expect(policy.resolve(undefined)).toEqual({
      transport: AuthCallbackTransport.DeepLink,
      source: AuthLoginTransportSource.Preference,
    });
  });

  test('lets an explicit request override the preference', () => {
    const { policy } = createPolicy({ [AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY]: deepLinkPreference });

    expect(policy.resolve(AuthCallbackTransport.Loopback)).toEqual({
      transport: AuthCallbackTransport.Loopback,
      source: AuthLoginTransportSource.Requested,
    });
  });

  test('ignores an unknown requested transport', () => {
    const { policy } = createPolicy();

    expect(policy.resolve('carrier_pigeon').transport).toBe(AuthCallbackTransport.Loopback);
  });

  test('falls back to the loopback callback when the store is unavailable', () => {
    const policy = new AuthLoginTransportPolicy({
      getStore: () => {
        throw new Error('store closed');
      },
      now: () => NOW,
    });

    expect(policy.resolve(undefined).transport).toBe(AuthCallbackTransport.Loopback);
  });
});

describe('AuthLoginTransportPolicy.recordCodeDelivered', () => {
  test('remembers the deep link when it delivered a loopback login', () => {
    const { policy, values } = createPolicy();
    policy.recordAttempt(AuthCallbackTransport.Loopback, AuthLoginTransportSource.Default);

    policy.recordCodeDelivered(AuthCallbackTransport.DeepLink);

    expect(values.get(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY)).toEqual(deepLinkPreference);
  });

  test('remembers the deep link after the user switched to it', () => {
    const { policy, values } = createPolicy();
    policy.recordAttempt(AuthCallbackTransport.DeepLink, AuthLoginTransportSource.Requested);

    policy.recordCodeDelivered(AuthCallbackTransport.DeepLink);

    expect(values.get(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY)).toEqual(deepLinkPreference);
  });

  test('does not extend a preference that chose the deep link by itself', () => {
    const storedPreference = { transport: AuthCallbackTransport.DeepLink, expiresAt: NOW + 1_000 };
    const { policy, values } = createPolicy({ [AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY]: storedPreference });
    policy.recordAttempt(AuthCallbackTransport.DeepLink, AuthLoginTransportSource.Preference);

    policy.recordCodeDelivered(AuthCallbackTransport.DeepLink);

    expect(values.get(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY)).toEqual(storedPreference);
  });

  test('ignores a deep link that arrives after the loopback callback delivered the attempt', () => {
    const { policy, values } = createPolicy();
    policy.recordAttempt(AuthCallbackTransport.Loopback, AuthLoginTransportSource.Default);
    policy.recordCodeDelivered(AuthCallbackTransport.Loopback);

    policy.recordCodeDelivered(AuthCallbackTransport.DeepLink);

    expect(values.has(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY)).toBe(false);
  });

  test('does not touch the store for a cold-start deep link', () => {
    const { policy, getStore } = createPolicy();

    policy.recordCodeDelivered(AuthCallbackTransport.DeepLink);

    expect(getStore).not.toHaveBeenCalled();
  });

  test('clears the preference once the loopback callback delivers again', () => {
    const { policy, values } = createPolicy({ [AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY]: deepLinkPreference });
    policy.recordAttempt(AuthCallbackTransport.Loopback, AuthLoginTransportSource.Requested);

    policy.recordCodeDelivered(AuthCallbackTransport.Loopback);

    expect(values.has(AUTH_CALLBACK_TRANSPORT_PREFERENCE_KEY)).toBe(false);
  });

  test('keeps working when the preference cannot be saved', () => {
    const { store } = createStore();
    const policy = new AuthLoginTransportPolicy({
      getStore: () => ({
        ...store,
        set: () => {
          throw new Error('disk full');
        },
      }),
      now: () => NOW,
    });
    policy.recordAttempt(AuthCallbackTransport.Loopback, AuthLoginTransportSource.Default);

    expect(() => policy.recordCodeDelivered(AuthCallbackTransport.DeepLink)).not.toThrow();
  });
});
