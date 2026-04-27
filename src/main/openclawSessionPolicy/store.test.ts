import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG,
  OPENCLAW_SESSION_MAINTENANCE,
  OPENCLAW_SESSION_POLICY_STORE_KEY,
  OpenClawSessionKeepAlive,
} from './constants';
import {
  buildOpenClawSessionConfig,
  loadOpenClawSessionPolicyConfig,
  mapKeepAliveToSessionReset,
  normalizeOpenClawSessionPolicyConfig,
  saveOpenClawSessionPolicyConfig,
} from './store';

describe('normalizeOpenClawSessionPolicyConfig', () => {
  test('falls back to default when keepAlive is invalid', () => {
    const config = normalizeOpenClawSessionPolicyConfig({ keepAlive: 'bad-value' });
    expect(config).toEqual(DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG);
  });
});

describe('mapKeepAliveToSessionReset', () => {
  test('maps seven days to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.SevenDays)).toEqual({
      mode: 'idle',
      idleMinutes: 10080,
    });
  });

  test('maps one day to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.OneDay)).toEqual({
      mode: 'idle',
      idleMinutes: 1440,
    });
  });


  test('maps thirty days to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.ThirtyDays)).toEqual({
      mode: 'idle',
      idleMinutes: 43200,
    });
  });

  test('maps one year to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.OneYear)).toEqual({
      mode: 'idle',
      idleMinutes: 525600,
    });
  });

});

describe('buildOpenClawSessionConfig', () => {
  test('builds session config with one-day reset and fixed maintenance', () => {
    expect(buildOpenClawSessionConfig({
      keepAlive: OpenClawSessionKeepAlive.OneDay,
    })).toEqual({
      dmScope: 'per-account-channel-peer',
      reset: {
        mode: 'idle',
        idleMinutes: 1440,
      },
      maintenance: OPENCLAW_SESSION_MAINTENANCE,
    });
  });


  test('uses default policy when omitted', () => {
    expect(buildOpenClawSessionConfig()).toEqual({
      dmScope: 'per-account-channel-peer',
      reset: {
        mode: 'idle',
        idleMinutes: 43200,
      },
      maintenance: OPENCLAW_SESSION_MAINTENANCE,
    });
  });
});

describe('DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG', () => {
  test('defaults keepAlive to thirty days', () => {
    expect(DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG).toEqual({
      keepAlive: OpenClawSessionKeepAlive.ThirtyDays,
    });
  });
});

describe('load/save session policy config', () => {
  const defaultConfig = DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG;


  test('load falls back to default when nothing stored', () => {
    const store = {
      get: vi.fn(() => undefined as undefined),
      set: vi.fn(),
    };
    const result = loadOpenClawSessionPolicyConfig(store);
    expect(store.get).toHaveBeenCalledWith(OPENCLAW_SESSION_POLICY_STORE_KEY);
    expect(result).toEqual(defaultConfig);
  });

  test('load returns normalized stored value', () => {
    const store = {
      get: vi.fn(() => ({ keepAlive: '1d' })),
      set: vi.fn(),
    };
    const result = loadOpenClawSessionPolicyConfig(store);
    expect(store.get).toHaveBeenCalledWith(OPENCLAW_SESSION_POLICY_STORE_KEY);
    expect(result).toEqual({ keepAlive: OpenClawSessionKeepAlive.OneDay });
  });

  test('save writes normalized configuration', () => {
    const store = {
      get: vi.fn(),
      set: vi.fn(),
    };
    const result = saveOpenClawSessionPolicyConfig(store, { keepAlive: 'bad' });
    expect(store.set).toHaveBeenCalledWith(OPENCLAW_SESSION_POLICY_STORE_KEY, defaultConfig);
    expect(result).toEqual(defaultConfig);
  });
});
