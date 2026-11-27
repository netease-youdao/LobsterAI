import { describe, expect, test } from 'vitest';

import { OpenClawProviderId } from '../../../shared/providers/constants';
import { LobsterAIRequestCapability } from '../../../shared/providers/lobsterAIRequestOptions';
import { ModelRuntimeProfile } from '../../../shared/providers/modelRuntimeProfiles';
import {
  type ModelThinkingConfig,
  ModelThinkingLevel,
  OpenClawThinkingLevel,
} from '../../../shared/providers/modelThinking';
import { resolveEffectiveDshReasoningEffort } from './dshModelSelection';

const GLM_THINKING_CONFIG: ModelThinkingConfig = {
  options: [
    { level: ModelThinkingLevel.Off, openclawLevel: OpenClawThinkingLevel.Off },
    { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
    { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
  ],
  defaultLevel: ModelThinkingLevel.High,
};

describe('resolveEffectiveDshReasoningEffort', () => {
  test('returns session thinking level when valid for lobsterai-options-v1 model', () => {
    const metadata = {
      supportsThinking: true,
      thinkingConfig: GLM_THINKING_CONFIG,
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    };

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: ModelThinkingLevel.Off,
      agentThinkingLevel: ModelThinkingLevel.Max,
    })).toBe(ModelThinkingLevel.Off);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: ModelThinkingLevel.Max,
      agentThinkingLevel: ModelThinkingLevel.Off,
    })).toBe(ModelThinkingLevel.Max);
  });

  test('inherits agent thinking level when session level is empty and inheritance is enabled', () => {
    const metadata = {
      supportsThinking: true,
      thinkingConfig: GLM_THINKING_CONFIG,
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    };

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: '',
      agentThinkingLevel: ModelThinkingLevel.Max,
      inheritAgentThinkingLevel: true,
    })).toBe(ModelThinkingLevel.Max);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: '',
      agentThinkingLevel: ModelThinkingLevel.Max,
      inheritAgentThinkingLevel: false,
    })).toBe(ModelThinkingLevel.High);
  });

  test('falls back to defaultLevel on missing, invalid, or reset thinking level', () => {
    const metadata = {
      supportsThinking: true,
      thinkingConfig: GLM_THINKING_CONFIG,
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
    };

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: '',
      agentThinkingLevel: '',
    })).toBe(ModelThinkingLevel.High);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      sessionThinkingLevel: ModelThinkingLevel.Low,
      agentThinkingLevel: ModelThinkingLevel.Max,
    })).toBe(ModelThinkingLevel.High);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      overrideThinkingLevel: '',
      sessionThinkingLevel: ModelThinkingLevel.Max,
    })).toBe(ModelThinkingLevel.High);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: metadata,
      overrideThinkingLevel: null,
      sessionThinkingLevel: ModelThinkingLevel.Off,
    })).toBe(ModelThinkingLevel.High);
  });

  test('fails closed when lobsterai-options-v1 capability or thinkingConfig is missing', () => {
    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: {
        supportsThinking: true,
        thinkingConfig: GLM_THINKING_CONFIG,
        requestCapabilities: [],
      },
      sessionThinkingLevel: ModelThinkingLevel.Max,
    })).toBeUndefined();

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: {
        supportsThinking: true,
      },
      sessionThinkingLevel: ModelThinkingLevel.Max,
    })).toBeUndefined();
  });

  test('forces max reasoning effort for lobsterai-server Kimi K3 profile', () => {
    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.LobsteraiServer,
      modelMetadata: {
        supportsThinking: true,
        runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
      },
      sessionThinkingLevel: ModelThinkingLevel.Off,
    })).toBe(ModelThinkingLevel.Max);
  });

  test('passes explicit or stored level through for non-server providers', () => {
    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.OpenAI,
      sessionThinkingLevel: ModelThinkingLevel.High,
    })).toBe(ModelThinkingLevel.High);

    expect(resolveEffectiveDshReasoningEffort({
      providerId: OpenClawProviderId.OpenAI,
      overrideThinkingLevel: null,
      sessionThinkingLevel: ModelThinkingLevel.High,
    })).toBeUndefined();
  });
});
