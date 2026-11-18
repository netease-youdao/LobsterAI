import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawProviderId } from '../../../shared/providers/constants';
import type { ProviderModelCatalog } from '../openclawAgentModels';
import {
  isStaleSessionModelOverride,
  resolveSessionModelOverrideAvailability,
  SessionModelOverrideAvailability,
  StaleSessionModelOverrideResetter,
} from './staleSessionModelOverride';

const catalog = {
  qwen: { models: [{ id: 'qwen3.6-plus' }] },
  [OpenClawProviderId.LobsteraiServer]: { models: [] },
};

describe('resolveSessionModelOverrideAvailability', () => {
  test('reports a model the synced provider set still lists as available', () => {
    expect(resolveSessionModelOverrideAvailability('qwen/qwen3.6-plus', catalog))
      .toBe(SessionModelOverrideAvailability.Available);
  });

  test('reports an override whose provider was removed', () => {
    expect(resolveSessionModelOverrideAvailability('deepseek/deepseek-v4-flash', catalog))
      .toBe(SessionModelOverrideAvailability.ProviderMissing);
  });

  test('reports an override whose model was removed from a configured provider', () => {
    expect(resolveSessionModelOverrideAvailability('qwen/qwen3.8-max', catalog))
      .toBe(SessionModelOverrideAvailability.ModelMissing);
  });

  test('reports a removed provider even when no custom provider is left', () => {
    expect(resolveSessionModelOverrideAvailability('deepseek/deepseek-v4-flash', {}))
      .toBe(SessionModelOverrideAvailability.ProviderMissing);
  });

  test('does not judge plan models, whose catalog loads after sign-in', () => {
    expect(resolveSessionModelOverrideAvailability(
      `${OpenClawProviderId.LobsteraiServer}/qwen3.7-max-YoudaoInner`,
      catalog,
    )).toBe(SessionModelOverrideAvailability.Unknown);
  });

  test.each(['', '   ', 'deepseek-v4-flash', 'deepseek/'])('does not judge %j', (modelRef) => {
    expect(resolveSessionModelOverrideAvailability(modelRef, catalog))
      .toBe(SessionModelOverrideAvailability.Unknown);
  });
});

describe('isStaleSessionModelOverride', () => {
  test('treats only a missing provider or model as stale', () => {
    expect(isStaleSessionModelOverride(SessionModelOverrideAvailability.ProviderMissing)).toBe(true);
    expect(isStaleSessionModelOverride(SessionModelOverrideAvailability.ModelMissing)).toBe(true);
    expect(isStaleSessionModelOverride(SessionModelOverrideAvailability.Available)).toBe(false);
    expect(isStaleSessionModelOverride(SessionModelOverrideAvailability.Unknown)).toBe(false);
  });
});

function createResetter(options: {
  overrides: Record<string, string>;
  sessionKeys?: Record<string, string>;
  busySessionIds?: string[];
  catalog?: ProviderModelCatalog;
  catalogError?: Error;
  patchError?: Error;
  holdPatch?: Promise<void>;
}) {
  const overrides = new Map(Object.entries(options.overrides));
  const patches: Array<{ sessionId: string; sessionKey: string }> = [];
  const cleared: Array<{ sessionId: string; modelRef: string }> = [];
  const resetter = new StaleSessionModelOverrideResetter({
    getModelCatalog: () => {
      if (options.catalogError) throw options.catalogError;
      return options.catalog ?? catalog;
    },
    normalizeModelRef: modelRef => modelRef.trim(),
    listChannelSessionModelOverrides: () => [...overrides]
      .filter(([sessionId, modelOverride]) => modelOverride && options.sessionKeys?.[sessionId])
      .map(([sessionId, modelOverride]) => ({
        sessionId,
        modelOverride,
        sessionKey: options.sessionKeys![sessionId],
      })),
    getSessionModelOverride: sessionId => overrides.get(sessionId) ?? null,
    isSessionBusy: sessionId => options.busySessionIds?.includes(sessionId) ?? false,
    patchModelToAgentDefault: async ({ sessionId, sessionKey, shouldPatch }) => {
      await options.holdPatch;
      if (!shouldPatch()) return false;
      if (options.patchError) throw options.patchError;
      patches.push({ sessionId, sessionKey });
      return true;
    },
    clearLocalModelOverride: (sessionId, modelRef) => {
      overrides.set(sessionId, '');
      cleared.push({ sessionId, modelRef });
    },
  });
  return { resetter, overrides, patches, cleared };
}

describe('StaleSessionModelOverrideResetter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('reconcile patches an IM session back to its agent model before clearing the local override', async () => {
    const imSessionKey = 'agent:main:moltbot-popo:bot:direct:user@example.com';
    const { resetter, overrides, patches, cleared } = createResetter({
      overrides: {
        im: 'deepseek/deepseek-v4-flash',
        available: 'qwen/qwen3.6-plus',
        plan: `${OpenClawProviderId.LobsteraiServer}/qwen3.7-max-YoudaoInner`,
        running: 'deepseek/deepseek-v4-flash',
        desktop: 'deepseek/deepseek-v4-flash',
      },
      sessionKeys: {
        im: imSessionKey,
        available: 'agent:main:feishu:dm:ou_1',
        plan: 'agent:main:feishu:dm:ou_2',
        running: 'agent:main:feishu:dm:ou_3',
      },
      busySessionIds: ['running'],
    });

    await resetter.reconcile('test');

    expect(patches).toEqual([{ sessionId: 'im', sessionKey: imSessionKey }]);
    expect(cleared).toEqual([{ sessionId: 'im', modelRef: 'deepseek/deepseek-v4-flash' }]);
    expect(Object.fromEntries(overrides)).toMatchObject({
      available: 'qwen/qwen3.6-plus',
      plan: `${OpenClawProviderId.LobsteraiServer}/qwen3.7-max-YoudaoInner`,
      running: 'deepseek/deepseek-v4-flash',
      // The picker flags a desktop session's model; a re-enabled provider keeps working.
      desktop: 'deepseek/deepseek-v4-flash',
    });
  });

  test('keeps the local override for a later retry when OpenClaw rejects the reset', async () => {
    const { resetter, overrides, cleared } = createResetter({
      overrides: { im: 'deepseek/deepseek-v4-flash' },
      sessionKeys: { im: 'agent:main:feishu:dm:ou_123' },
      patchError: new Error('gateway request timeout for sessions.patch'),
    });

    await expect(resetter.reset({
      sessionId: 'im',
      sessionKey: 'agent:main:feishu:dm:ou_123',
      modelRef: 'deepseek/deepseek-v4-flash',
      availability: SessionModelOverrideAvailability.ProviderMissing,
      trigger: 'test',
    })).resolves.toBe(false);

    expect(cleared).toEqual([]);
    expect(overrides.get('im')).toBe('deepseek/deepseek-v4-flash');
  });

  test('patches OpenClaw even when the local mirror never recorded the override', async () => {
    const sessionKey = 'agent:main:feishu:dm:ou_123';
    const { resetter, patches, cleared } = createResetter({ overrides: { im: '' } });

    await expect(resetter.reset({
      sessionId: 'im',
      sessionKey,
      modelRef: 'deepseek/deepseek-v4-flash',
      availability: SessionModelOverrideAvailability.ProviderMissing,
      trigger: 'test',
    })).resolves.toBe(false);

    expect(patches).toEqual([{ sessionId: 'im', sessionKey }]);
    expect(cleared).toEqual([]);
  });

  test('leaves a model the user picked while the reset was waiting', async () => {
    let releasePatch: () => void = () => undefined;
    const holdPatch = new Promise<void>((resolve) => { releasePatch = resolve; });
    const { resetter, overrides, patches, cleared } = createResetter({
      overrides: { im: 'deepseek/deepseek-v4-flash' },
      holdPatch,
    });

    const reset = resetter.reset({
      sessionId: 'im',
      sessionKey: 'agent:main:feishu:dm:ou_123',
      modelRef: 'deepseek/deepseek-v4-flash',
      availability: SessionModelOverrideAvailability.ProviderMissing,
      trigger: 'test',
    });
    overrides.set('im', 'qwen/qwen3.6-plus');
    releasePatch();

    await expect(reset).resolves.toBe(false);
    expect(patches).toEqual([]);
    expect(cleared).toEqual([]);
    expect(overrides.get('im')).toBe('qwen/qwen3.6-plus');
  });

  test('shares one reset between concurrent triggers for the same session', async () => {
    let releasePatch: () => void = () => undefined;
    const holdPatch = new Promise<void>((resolve) => { releasePatch = resolve; });
    const { resetter, patches, cleared } = createResetter({
      overrides: { im: 'deepseek/deepseek-v4-flash' },
      holdPatch,
    });
    const options = {
      sessionId: 'im',
      sessionKey: 'agent:main:feishu:dm:ou_123',
      modelRef: 'deepseek/deepseek-v4-flash',
      availability: SessionModelOverrideAvailability.ProviderMissing,
      trigger: 'test',
    };

    const first = resetter.reset(options);
    const second = resetter.reset(options);
    releasePatch();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(patches).toHaveLength(1);
    expect(cleared).toHaveLength(1);
  });

  test('does not judge a model while the provider catalog is unavailable', () => {
    const { resetter } = createResetter({ overrides: {} });
    const { resetter: failing } = createResetter({ overrides: {}, catalogError: new Error('store not ready') });

    expect(resetter.findStaleReason('deepseek/deepseek-v4-flash'))
      .toBe(SessionModelOverrideAvailability.ProviderMissing);
    expect(resetter.findStaleReason('')).toBeNull();
    expect(failing.findStaleReason('deepseek/deepseek-v4-flash')).toBeNull();
  });
});
