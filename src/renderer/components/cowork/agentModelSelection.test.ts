import { LobsterAIRequestCapability } from '@shared/providers/lobsterAIRequestOptions';
import { ModelThinkingLevel } from '@shared/providers/modelThinking';
import { describe, expect, test } from 'vitest';

import type { Model } from '../../store/slices/modelSlice';
import {
  resolveAgentModelSelection,
  resolveAgentStartModel,
  resolveEffectiveModel,
  resolveModelThinkingLevel,
} from './agentModelSelection';

const models: Model[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek Server', providerKey: 'openai', isServerModel: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', providerKey: 'moonshot' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 Server', providerKey: 'lobsterai-server', isServerModel: true },
];

const visionModel: Model = { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', providerKey: 'qwen', supportsImage: true };
const nonVisionModel: Model = { id: 'glm-5.1', name: 'GLM 5.1', providerKey: 'zhipu', supportsImage: false };
const configurableThinkingModel: Model = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  providerKey: 'lobsterai-server',
  requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
  thinkingConfig: {
    options: [
      { level: ModelThinkingLevel.Off, openclawLevel: 'off' },
      { level: ModelThinkingLevel.High, openclawLevel: 'high' },
      { level: ModelThinkingLevel.Max, openclawLevel: 'xhigh' },
    ],
    defaultLevel: ModelThinkingLevel.High,
  },
};

describe('resolveModelThinkingLevel', () => {
  test('keeps a persisted level supported by the selected model', () => {
    expect(resolveModelThinkingLevel(
      configurableThinkingModel,
      ModelThinkingLevel.Off,
    )).toBe(ModelThinkingLevel.Off);
  });

  test('falls back to the model default when persisted data is empty or unsupported', () => {
    expect(resolveModelThinkingLevel(configurableThinkingModel, '')).toBe(ModelThinkingLevel.High);
    expect(resolveModelThinkingLevel(
      configurableThinkingModel,
      ModelThinkingLevel.Low,
    )).toBe(ModelThinkingLevel.High);
  });

  test('does not attach a thinking level to models without configuration', () => {
    expect(resolveModelThinkingLevel(nonVisionModel, ModelThinkingLevel.Max)).toBeUndefined();
  });

  test('does not attach a thinking level after the server withdraws request-options support', () => {
    expect(resolveModelThinkingLevel(
      { ...configurableThinkingModel, requestCapabilities: undefined },
      ModelThinkingLevel.High,
    )).toBeUndefined();
  });
});

describe('resolveAgentModelSelection', () => {
  test('uses explicit agent model when present', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('claude-sonnet-4');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('prefers explicit session model override over agent model', () => {
    const result = resolveAgentModelSelection({
      sessionModel: 'openai/gpt-4o',
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('resolves same-id server session model to the server model', () => {
    const result = resolveAgentModelSelection({
      sessionModel: 'lobsterai-server/kimi-k2.6',
      agentModel: 'moonshot/kimi-k2.6',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.providerKey).toBe('lobsterai-server');
    expect(result.selectedModel?.isServerModel).toBe(true);
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('resolves same-id server agent model to the server model', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'lobsterai-server/kimi-k2.6',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.providerKey).toBe('lobsterai-server');
    expect(result.selectedModel?.isServerModel).toBe(true);
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('falls back to the global model in openclaw when agent model is empty', () => {
    const result = resolveAgentModelSelection({
      agentModel: '',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('preserves explicit model resolution for the only supported engine', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('claude-sonnet-4');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('silently falls back when agent model is invalid (not a session-level choice)', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deleted-model',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('silently falls back when agent model is an ambiguous bare id', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deepseek-v3.2',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('marks invalid session model override as error', () => {
    const result = resolveAgentModelSelection({
      sessionModel: 'deleted-provider/deleted-model',
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });
});

describe('resolveEffectiveModel', () => {
  test('home page (no sessionId) uses globalSelectedModel even when agent model differs', () => {
    // Bug scenario: agent default model supports images, user picked a non-vision model in header
    const result = resolveEffectiveModel({
      sessionId: undefined,
      agentSelectedModel: visionModel,
      globalSelectedModel: nonVisionModel,
    });

    expect(result?.id).toBe('glm-5.1');
    expect(result?.supportsImage).toBe(false);
  });

  test('home page uses globalSelectedModel supportsImage=true when user picks vision model', () => {
    const result = resolveEffectiveModel({
      sessionId: undefined,
      agentSelectedModel: nonVisionModel,
      globalSelectedModel: visionModel,
    });

    expect(result?.id).toBe('qwen3.5-plus');
    expect(result?.supportsImage).toBe(true);
  });

  test('inside session (has sessionId) uses agentSelectedModel from session override', () => {
    const result = resolveEffectiveModel({
      sessionId: 'session-123',
      agentSelectedModel: nonVisionModel,
      globalSelectedModel: visionModel,
    });

    expect(result?.id).toBe('glm-5.1');
    expect(result?.supportsImage).toBe(false);
  });
});

describe('resolveAgentStartModel', () => {
  const customQwen: Model = { id: 'qwen3.8-max', name: 'Qwen Max', providerKey: 'qwen' };
  const customGlm: Model = { id: 'glm-5.1', name: 'GLM 5.1', providerKey: 'zhipu' };
  const planFlash: Model = { id: 'qwen3.8-flash', name: 'Flash', providerKey: 'lobsterai-server', isServerModel: true };
  const planMaxLocked: Model = {
    id: 'qwen3.8-max', name: 'Qwen Max Plan', providerKey: 'lobsterai-server', isServerModel: true, accessible: false,
  };

  test('starts with the configured model when it is usable', () => {
    expect(resolveAgentStartModel({
      agentModel: 'qwen/qwen3.8-max',
      availableModels: [customQwen, planFlash],
      selectedModel: customQwen,
    })).toEqual({ model: customQwen, unavailableModelRef: null, crossesBillingSide: false });
  });

  test('blocks a missing custom model from silently becoming a plan model', () => {
    expect(resolveAgentStartModel({
      agentModel: 'qwen/qwen3.8-max',
      availableModels: [planMaxLocked, planFlash],
      selectedModel: planFlash,
    })).toEqual({ model: planFlash, unavailableModelRef: 'qwen/qwen3.8-max', crossesBillingSide: true });
  });

  test('blocks a locked plan model from silently becoming a custom model', () => {
    expect(resolveAgentStartModel({
      agentModel: 'lobsterai-server/qwen3.8-max',
      availableModels: [planMaxLocked, customGlm],
      selectedModel: customGlm,
    }).crossesBillingSide).toBe(true);
  });

  test('keeps silent fallback within one billing side and while the plan catalog is not loaded', () => {
    expect(resolveAgentStartModel({
      agentModel: 'qwen/qwen3.8-max',
      availableModels: [customGlm],
      selectedModel: customGlm,
    })).toEqual({ model: customGlm, unavailableModelRef: 'qwen/qwen3.8-max', crossesBillingSide: false });
    expect(resolveAgentStartModel({
      agentModel: 'lobsterai-server/qwen3.8-max',
      availableModels: [planMaxLocked, planFlash],
      selectedModel: planFlash,
    }).crossesBillingSide).toBe(false);
    expect(resolveAgentStartModel({
      agentModel: 'lobsterai-server/qwen3.8-max',
      availableModels: [customGlm],
      selectedModel: customGlm,
    }).crossesBillingSide).toBe(false);
  });

  test('uses the global selection when the agent has no model', () => {
    expect(resolveAgentStartModel({ agentModel: '', availableModels: [planFlash], selectedModel: planFlash }))
      .toEqual({ model: planFlash, unavailableModelRef: null, crossesBillingSide: false });
  });
});
