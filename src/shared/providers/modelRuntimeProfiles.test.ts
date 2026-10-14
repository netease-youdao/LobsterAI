import { describe, expect, test } from 'vitest';

import { OpenClawApi, OpenClawProviderId } from './constants';
import {
  applyModelRuntimeProfileMetadata,
  findKimiK3ReservedCustomParamKeys,
  getModelRuntimeProfileDefinition,
  KIMI_K3_RUNTIME_PROFILE,
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
