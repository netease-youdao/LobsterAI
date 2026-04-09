import { describe, expect, test } from 'vitest';

import type { Model } from '../../store/slices/modelSlice';
import { resolveAgentModelSelection } from './agentModelSelection';

const models: Model[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek Server', providerKey: 'openai', isServerModel: true },
];

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

  test('uses fallback model outside openclaw without marking fallback mode', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'yd_cowork',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('marks invalid explicit model as fallback to global model', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deleted-model',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });

  test('treats ambiguous bare model ids as invalid instead of guessing a provider', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deepseek-v3.2',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });
});
