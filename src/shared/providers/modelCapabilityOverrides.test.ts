import { describe, expect, test } from 'vitest';

import { ProviderName } from './constants';
import { buildModelCapabilityOverrides } from './modelCapabilityOverrides';

describe('buildModelCapabilityOverrides', () => {
  test('records choices that the provider preset would otherwise discard', () => {
    expect(buildModelCapabilityOverrides(ProviderName.Xiaomi, 'mimo-v2.5-pro', {
      supportsImage: true,
      supportsThinking: false,
    })).toEqual({ image: true, thinking: false });
  });

  test('leaves choices that match the preset unset so preset updates still apply', () => {
    expect(buildModelCapabilityOverrides(ProviderName.Xiaomi, 'mimo-v2.6-pro', {
      supportsImage: true,
      supportsThinking: true,
    })).toBeUndefined();
    expect(buildModelCapabilityOverrides(ProviderName.Xiaomi, 'mimo-v2.6-pro', {
      supportsImage: false,
      supportsThinking: true,
    })).toEqual({ image: false });
  });

  test('needs no override for unknown models, whose configured value already wins', () => {
    expect(buildModelCapabilityOverrides('custom_0', 'my-private-model', {
      supportsImage: true,
      supportsThinking: false,
    })).toBeUndefined();
  });

  test('overrides a globally known vision model on a custom provider', () => {
    expect(buildModelCapabilityOverrides('custom_0', 'qwen3.6-plus', {
      supportsImage: false,
      supportsThinking: false,
    })).toEqual({ image: false });
  });
});
