import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import {
  clearServerModelMetadata,
  evaluateServerModelRunGate,
  getAllServerModelMetadata,
  ServerModelRunGateReason,
  updateServerModelMetadata,
} from './claudeSettings';

beforeEach(() => {
  clearServerModelMetadata();
  vi.restoreAllMocks();
});

describe('server model metadata cache', () => {
  test('preserves K3 runtime and agentic capability metadata', () => {
    expect(updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingConfig: undefined,
      supportsToolCalling: true,
      agenticReady: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    }])).toBe(true);

    expect(getAllServerModelMetadata()).toEqual([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      supportsToolCalling: true,
      agenticReady: true,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      explicitContextCache: undefined,
    }]);
  });

  test('overrides untrusted K3 capability values with the client runtime profile', () => {
    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: false,
      supportsVideo: false,
      supportsThinking: false,
      supportsToolCalling: false,
      agenticReady: false,
      contextWindow: 4_096,
      maxTokens: 1_024,
    }]);

    expect(getAllServerModelMetadata()[0]).toMatchObject({
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      supportsToolCalling: false,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.ToolCallingUnavailable,
    });
  });

  test('treats identical metadata as unchanged', () => {
    const metadata = [{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsToolCalling: true,
      agenticReady: false,
    }];

    expect(updateServerModelMetadata(metadata)).toBe(true);
    expect(updateServerModelMetadata(metadata)).toBe(false);
  });

  test('preserves valid thinking configuration and detects config changes', () => {
    const base = {
      modelId: 'deepseek-v4-flash',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: ['lobsterai-options-v1', 'future-options-v2'],
    };

    expect(updateServerModelMetadata([base])).toBe(true);
    expect(getAllServerModelMetadata()[0].thinkingConfig).toEqual(base.thinkingConfig);
    expect(getAllServerModelMetadata()[0].requestCapabilities).toEqual([
      'lobsterai-options-v1',
    ]);
    expect(updateServerModelMetadata([base])).toBe(false);
    expect(updateServerModelMetadata([{
      ...base,
      thinkingConfig: { ...base.thinkingConfig, defaultLevel: 'max' },
    }])).toBe(true);
  });

  test('ignores invalid thinking configuration', () => {
    updateServerModelMetadata([{
      modelId: 'deepseek-v4-flash',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
        ],
        defaultLevel: 'max',
      },
    }]);

    expect(getAllServerModelMetadata()[0].thinkingConfig).toBeUndefined();
  });

  test('rejects an unknown runtime profile without exposing it to config consumers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(updateServerModelMetadata([{
      modelId: 'future-model',
      runtimeProfile: 'server-controlled-compat-json',
    }])).toBe(true);
    expect(getAllServerModelMetadata()[0].runtimeProfile).toBeUndefined();
    expect(evaluateServerModelRunGate('future-model')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.RuntimeProfileUnsupported,
    });
    expect(updateServerModelMetadata([{
      modelId: 'future-model',
      runtimeProfile: 'server-controlled-compat-json',
    }])).toBe(false);
  });
});

describe('server model run gate', () => {
  test('fails closed when exact metadata is missing', () => {
    expect(evaluateServerModelRunGate('missing-model')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.MetadataMissing,
    });
  });

  test('allows ordinary server models without K3-specific gates', () => {
    updateServerModelMetadata([{
      modelId: 'qwen3.7-plus-YoudaoInner',
      supportsToolCalling: false,
      agenticReady: false,
    }]);

    expect(evaluateServerModelRunGate('qwen3.7-plus-YoudaoInner')).toMatchObject({
      allowed: true,
      metadata: { modelId: 'qwen3.7-plus-YoudaoInner' },
    });
  });

  test('requires both tool calling and agentic readiness for package K3', () => {
    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsToolCalling: false,
      agenticReady: true,
    }]);
    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.ToolCallingUnavailable,
    });

    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsToolCalling: true,
      agenticReady: false,
    }]);
    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.AgenticNotReady,
    });

    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsToolCalling: true,
      agenticReady: true,
    }]);
    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toMatchObject({
      allowed: true,
      metadata: {
        modelId: 'kimi-k3-YoudaoInner',
        runtimeProfile: 'moonshot-kimi-k3',
      },
    });
  });

  test('fails closed for a precise K3 candidate without a runtime profile', () => {
    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      supportsToolCalling: true,
      agenticReady: true,
    }]);

    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.RuntimeProfileMissing,
    });
  });

  test('recognizes the controlled K3 package id even when provider metadata is missing', () => {
    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      apiFormat: 'openai',
      supportsToolCalling: true,
      agenticReady: true,
    }]);

    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.RuntimeProfileMissing,
    });
  });

  test('requires the OpenAI transport for the K3 profile', () => {
    updateServerModelMetadata([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'anthropic',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsToolCalling: true,
      agenticReady: true,
    }]);

    expect(evaluateServerModelRunGate('kimi-k3-YoudaoInner')).toEqual({
      allowed: false,
      reason: ServerModelRunGateReason.TransportUnsupported,
    });
  });
});
