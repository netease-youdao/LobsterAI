import { describe, expect, test } from 'vitest';

import { OpenClawApi, OpenClawProviderId } from './constants';
import { buildModelCapabilityOverrides } from './modelCapabilityOverrides';
import {
  applyModelRuntimeProfileDefaults,
  applyModelRuntimeProfileMetadata,
  findKimiK3ReservedCustomParamKeys,
  getModelRuntimeProfileDefinition,
  KIMI_K3_RUNTIME_PROFILE,
  migrateKimiK3LegacyCustomParams,
  ModelRuntimeProfile,
  ModelRuntimeProfileSource,
  normalizeModelIdForComparison,
  parseModelRuntimeProfile,
  resolveModelRuntimeProfile,
} from './modelRuntimeProfiles';

const resolve = (
  overrides: Partial<Parameters<typeof resolveModelRuntimeProfile>[0]> = {},
) => resolveModelRuntimeProfile({
  source: ModelRuntimeProfileSource.BuiltIn,
  providerId: OpenClawProviderId.Moonshot,
  modelId: 'kimi-k3',
  api: OpenClawApi.OpenAICompletions,
  ...overrides,
});

describe('Kimi K3 runtime profile', () => {
  test('matches the controlled OpenClaw profile', () => {
    expect(getModelRuntimeProfileDefinition(ModelRuntimeProfile.MoonshotKimiK3)).toEqual({
      reasoning: true,
      input: ['text', 'image', 'video'],
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      thinkingLevelMap: {
        off: null,
        minimal: 'max',
        low: 'max',
        medium: 'max',
        high: 'max',
        xhigh: 'max',
        max: 'max',
      },
      compat: {
        maxTokensField: 'max_tokens',
        supportsUsageInStreaming: false,
        requiresStringContent: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: [
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
      },
    });
    expect(KIMI_K3_RUNTIME_PROFILE.maxTokens).toBe(1_048_576);
  });

  test('parses only controlled persisted values', () => {
    expect(parseModelRuntimeProfile('moonshot-kimi-k3')).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(parseModelRuntimeProfile('unknown')).toBeUndefined();
    expect(parseModelRuntimeProfile({ profile: 'moonshot-kimi-k3' })).toBeUndefined();
  });
});

describe('model identity', () => {
  test('normalizes equivalent model IDs without fuzzy matching', () => {
    expect(normalizeModelIdForComparison(' Kimi_K3 ')).toBe('kimik3');
    expect(normalizeModelIdForComparison('kimi.k3')).toBe('kimik3');
    expect(normalizeModelIdForComparison('my-kimi-k3')).toBe('mykimik3');
  });
});

describe('resolveModelRuntimeProfile', () => {
  test('resolves exact Kimi K3 IDs for built-in and custom providers', () => {
    expect(resolve()).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(resolve({ modelId: 'Kimi_K3' })).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(resolve({ modelId: 'kimi.k3' })).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(resolve({
      providerId: OpenClawProviderId.OpenAI,
    })).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(resolve({
      source: ModelRuntimeProfileSource.Custom,
      providerId: 'custom_0',
    })).toBe(ModelRuntimeProfile.MoonshotKimiK3);
  });

  test('requires the exact model ID and OpenAI-compatible transport', () => {
    expect(resolve({ modelId: 'my-kimi-prod' })).toBeUndefined();
    expect(resolve({ api: OpenClawApi.AnthropicMessages })).toBeUndefined();
    expect(resolve({
      source: 'unknown' as ModelRuntimeProfileSource,
    })).toBeUndefined();
  });

  test('applies the fixed Kimi K3 metadata profile', () => {
    const profile = resolve({
      source: ModelRuntimeProfileSource.Custom,
      providerId: 'custom_9',
    });

    expect(profile).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(applyModelRuntimeProfileMetadata({
      supportsImage: false,
      supportsThinking: false,
      contextWindow: 200_000,
    }, profile)).toEqual({
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
  });

  test('accepts only controlled server profiles on the package provider', () => {
    expect(resolve({
      source: ModelRuntimeProfileSource.Server,
      providerId: OpenClawProviderId.LobsteraiServer,
      modelId: 'kimi-k3-YoudaoInner',
      serverRuntimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
    })).toBe(ModelRuntimeProfile.MoonshotKimiK3);
    expect(resolve({
      source: ModelRuntimeProfileSource.Server,
      providerId: OpenClawProviderId.LobsteraiServer,
      modelId: 'kimi-k3-YoudaoInner',
      serverRuntimeProfile: 'unknown-profile',
    })).toBeUndefined();
  });
});

test('findKimiK3ReservedCustomParamKeys reports only runtime-owned keys', () => {
  expect(findKimiK3ReservedCustomParamKeys({
    reasoning_effort: 'low',
    max_tokens: 4096,
    service_tier: 'priority',
    temperature: 1,
  })).toEqual(['max_tokens', 'reasoning_effort', 'temperature']);
  expect(findKimiK3ReservedCustomParamKeys({ service_tier: 'priority' })).toEqual([]);
});

describe('applyModelRuntimeProfileDefaults', () => {
  test('fills missing Kimi K3 limits and repairs unoverridden flags while preserving explicit user settings', () => {
    expect(applyModelRuntimeProfileDefaults({
      supportsImage: false,
      supportsThinking: false,
    }, ModelRuntimeProfile.MoonshotKimiK3)).toEqual({
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });

    expect(applyModelRuntimeProfileDefaults({
      supportsImage: false,
      supportsThinking: true,
      contextWindow: 200_000,
      maxTokens: 262_144,
    }, ModelRuntimeProfile.MoonshotKimiK3, {
      supportsImage: false,
    })).toEqual({
      supportsImage: false,
      supportsVideo: true,
      supportsThinking: true,
      contextWindow: 200_000,
      maxTokens: 262_144,
    });
  });

  test('buildModelCapabilityOverrides tracks explicit opt-outs against K3 runtime profile defaults', () => {
    expect(buildModelCapabilityOverrides(
      'custom_0',
      'kimi-k3',
      { supportsImage: true, supportsThinking: true },
      ModelRuntimeProfile.MoonshotKimiK3,
    )).toBeUndefined();

    expect(buildModelCapabilityOverrides(
      'custom_0',
      'kimi-k3',
      { supportsImage: false, supportsThinking: false },
      ModelRuntimeProfile.MoonshotKimiK3,
    )).toEqual({ image: false, thinking: false });
  });
});

describe('migrateKimiK3LegacyCustomParams', () => {
  test('promotes legacy max_tokens into maxTokens over stock/legacy defaults and drops empty customParams', () => {
    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: 262_144 },
      1_048_576,
    )).toEqual({
      customParams: undefined,
      migratedMaxTokens: 262_144,
      strippedKeys: ['max_tokens'],
    });

    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: 65_536, temperature: 1, compat: { maxTokensField: 'max_tokens' }, service_tier: 'priority' },
      8_192,
    )).toEqual({
      customParams: { service_tier: 'priority' },
      migratedMaxTokens: 65_536,
      strippedKeys: ['compat', 'max_tokens', 'temperature'],
    });
  });

  test('preserves already-customized maxTokens and respects promoteOverDefaultMaxTokens: false', () => {
    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: 262_144 },
      65_536,
    )).toEqual({
      customParams: undefined,
      migratedMaxTokens: undefined,
      strippedKeys: ['max_tokens'],
    });

    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: 262_144 },
      1_048_576,
      { promoteOverDefaultMaxTokens: false },
    )).toEqual({
      customParams: undefined,
      migratedMaxTokens: undefined,
      strippedKeys: ['max_tokens'],
    });

    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: 262_144 },
      undefined,
      { promoteOverDefaultMaxTokens: false },
    )).toEqual({
      customParams: undefined,
      migratedMaxTokens: 262_144,
      strippedKeys: ['max_tokens'],
    });
  });

  test('ignores out-of-range or non-integer max_tokens while keeping non-reserved keys intact', () => {
    expect(migrateKimiK3LegacyCustomParams(
      { max_tokens: '262144', top_k: 32 },
      undefined,
    )).toEqual({
      customParams: { top_k: 32 },
      migratedMaxTokens: undefined,
      strippedKeys: ['max_tokens'],
    });

    expect(migrateKimiK3LegacyCustomParams(
      { service_tier: 'priority' },
      undefined,
    )).toEqual({
      customParams: { service_tier: 'priority' },
      migratedMaxTokens: undefined,
      strippedKeys: [],
    });
  });
});
