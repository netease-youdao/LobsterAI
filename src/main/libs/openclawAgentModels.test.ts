import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { DefaultAgentAvatarIcon } from '../../shared/agent/avatar';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from './openclawAgentModels';

describe('buildAgentEntry', () => {
  test('emits explicit model.primary for the main agent', () => {
    const result = buildAgentEntry({
      id: 'main',
      name: 'main',
      description: '',
      systemPrompt: '',
      identity: '',
      model: 'lobsterai-server/deepseek-v3.2',
      workingDirectory: '',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: true,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'anthropic/claude-sonnet-4');

    expect(result).toMatchObject({
      id: 'main',
      default: true,
      model: { primary: 'lobsterai-server/deepseek-v3.2' },
    });
  });

  test('rewrites stale OpenAI Codex model.primary when available providers moved it', () => {
    const result = buildAgentEntry({
      id: 'main',
      name: 'main',
      description: '',
      systemPrompt: '',
      identity: '',
      model: 'openai-codex/gpt-5.3-codex',
      workingDirectory: '',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: true,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'deepseek/deepseek-v4-flash', {
      availableProviders: {
        openai: { models: [{ id: 'gpt-5.3-codex' }] },
      },
    });

    expect(result).toMatchObject({
      id: 'main',
      model: { primary: 'openai/gpt-5.3-codex' },
    });
  });

  test('keeps explicit server model.primary when a custom provider has the same model id', () => {
    const result = buildAgentEntry({
      id: 'main',
      name: 'main',
      description: '',
      systemPrompt: '',
      identity: '',
      model: 'lobsterai-server/kimi-k2.6',
      workingDirectory: '',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: true,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'deepseek/deepseek-v4-flash', {
      availableProviders: {
        moonshot: { models: [{ id: 'kimi-k2.6' }] },
      },
    });

    expect(result).toMatchObject({
      id: 'main',
      model: { primary: 'lobsterai-server/kimi-k2.6' },
    });
  });

  test('falls back to the default model when agent model is an ambiguous bare id', () => {
    const result = buildAgentEntry({
      id: 'main',
      name: 'main',
      description: '',
      systemPrompt: '',
      identity: '',
      model: 'deepseek-v3.2',
      workingDirectory: '',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: true,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'anthropic/claude-sonnet-4');

    expect(result).toMatchObject({
      id: 'main',
      model: { primary: 'anthropic/claude-sonnet-4' },
    });
  });

  test('emits per-agent cwd when a working directory is configured', () => {
    const result = buildAgentEntry({
      id: 'docs',
      name: 'Docs',
      description: '',
      systemPrompt: '',
      identity: '',
      model: '',
      workingDirectory: '/tmp/docs-project',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: false,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'anthropic/claude-sonnet-4');

    expect(result).toMatchObject({
      id: 'docs',
      cwd: path.resolve('/tmp/docs-project'),
    });
  });

  test('does not forward designed avatar metadata as an OpenClaw emoji', () => {
    const result = buildAgentEntry({
      id: 'designer',
      name: 'Designer',
      description: '',
      systemPrompt: '',
      identity: '',
      model: '',
      workingDirectory: '',
      icon: DefaultAgentAvatarIcon,
      skillIds: [],
      enabled: true,
      isDefault: false,
      source: 'custom',
      presetId: '',
      createdAt: 0,
      updatedAt: 0,
    }, 'anthropic/claude-sonnet-4');

    const identity = result.identity as Record<string, unknown>;
    expect(identity.name).toBe('Designer');
    expect(identity.emoji).toBeUndefined();
  });
});

describe('buildManagedAgentEntries', () => {
  test('emits explicit model.primary for enabled non-main agents', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'openai/gpt-4o',
          workingDirectory: '',
          icon: '✍️',
          skillIds: ['docx'],
          enabled: true,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
    });

    expect(result).toContainEqual(expect.objectContaining({
      id: 'writer',
      model: { primary: 'openai/gpt-4o' },
      skills: ['docx'],
    }));
  });

  test('falls back to the default primary model when agent model is empty', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: '',
          icon: '✍️',
          skillIds: [],
          enabled: true,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
    });

    expect(result[0]).toMatchObject({
      id: 'writer',
      model: { primary: 'anthropic/claude-sonnet-4' },
    });
  });

  test('sets explicit workspace for non-main agents when stateDir is provided', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'crab-boss',
          name: 'CrabBoss',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'openai/gpt-4o',
          workingDirectory: '',
          icon: '🦀',
          skillIds: [],
          enabled: true,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
      stateDir: '/mock/state',
    });

    expect(result[0]).toMatchObject({
      id: 'crab-boss',
      workspace: expect.stringContaining('workspace-crab-boss'),
    });
  });
});

describe('parsePrimaryModelRef', () => {
  test('parses provider-qualified primary model refs', () => {
    expect(parsePrimaryModelRef('lobsterai-server/deepseek-v3.2')).toEqual({
      providerId: 'lobsterai-server',
      modelId: 'deepseek-v3.2',
      primaryModel: 'lobsterai-server/deepseek-v3.2',
    });
  });

  test('returns null for bare model ids', () => {
    expect(parsePrimaryModelRef('deepseek-v3.2')).toBeNull();
  });
});

describe('resolveManagedSessionModelTarget', () => {
  const availableProviders = {
    'lobsterai-server': { models: [{ id: 'qwen3.5-plus' }, { id: 'deepseek-v3.2' }] },
    minimax: { models: [{ id: 'MiniMax-M2.7' }] },
  };

  test('uses fallback target when agent model is empty', () => {
    expect(resolveManagedSessionModelTarget({
      agentModel: '',
      fallbackPrimaryModel: 'lobsterai-server/qwen3.5-plus',
      availableProviders,
    })).toEqual({
      providerId: 'lobsterai-server',
      modelId: 'qwen3.5-plus',
      primaryModel: 'lobsterai-server/qwen3.5-plus',
    });
  });

  test('keeps explicit provider-qualified models', () => {
    expect(resolveManagedSessionModelTarget({
      agentModel: 'minimax/MiniMax-M2.7',
      fallbackPrimaryModel: 'lobsterai-server/qwen3.5-plus',
      availableProviders,
    })).toEqual({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      primaryModel: 'minimax/MiniMax-M2.7',
    });
  });

  test('resolves bare model ids against available providers', () => {
    expect(resolveManagedSessionModelTarget({
      agentModel: 'deepseek-v3.2',
      fallbackPrimaryModel: 'lobsterai-server/qwen3.5-plus',
      availableProviders,
    })).toEqual({
      providerId: 'lobsterai-server',
      modelId: 'deepseek-v3.2',
      primaryModel: 'lobsterai-server/deepseek-v3.2',
    });
  });

  test('falls back to current provider when bare model cannot be resolved uniquely', () => {
    expect(resolveManagedSessionModelTarget({
      agentModel: 'unknown-model',
      fallbackPrimaryModel: 'lobsterai-server/qwen3.5-plus',
      availableProviders,
      currentProviderId: 'lobsterai-server',
    })).toEqual({
      providerId: 'lobsterai-server',
      modelId: 'unknown-model',
      primaryModel: 'lobsterai-server/unknown-model',
    });
  });
});

describe('resolveQualifiedAgentModelRef', () => {
  test('qualifies bare model ids when exactly one provider matches', () => {
    expect(resolveQualifiedAgentModelRef({
      agentModel: 'deepseek-v3.2',
      availableProviders: {
        'lobsterai-server': { models: [{ id: 'deepseek-v3.2' }] },
        minimax: { models: [{ id: 'MiniMax-M2.7' }] },
      },
    })).toEqual({
      status: 'qualified',
      primaryModel: 'lobsterai-server/deepseek-v3.2',
    });
  });

  test('does not auto-qualify bare model ids when multiple providers match', () => {
    expect(resolveQualifiedAgentModelRef({
      agentModel: 'deepseek-v3.2',
      availableProviders: {
        anthropic: { models: [{ id: 'deepseek-v3.2' }] },
        'lobsterai-server': { models: [{ id: 'deepseek-v3.2' }] },
      },
    })).toEqual({
      status: 'ambiguous',
      modelId: 'deepseek-v3.2',
      providerIds: ['anthropic', 'lobsterai-server'],
    });
  });

  test('rewrites legacy OpenAI Codex qualified refs when the model moved to one provider', () => {
    expect(resolveQualifiedAgentModelRef({
      agentModel: 'openai-codex/gpt-5.3-codex',
      availableProviders: {
        openai: { models: [{ id: 'gpt-5.3-codex' }] },
      },
    })).toEqual({
      status: 'qualified',
      primaryModel: 'openai/gpt-5.3-codex',
    });
  });

  test('rewrites MiniMax API refs to the portal provider when OAuth provider is configured', () => {
    expect(resolveQualifiedAgentModelRef({
      agentModel: 'minimax/MiniMax-M3',
      availableProviders: {
        'minimax-portal': { models: [{ id: 'MiniMax-M3' }] },
      },
    })).toEqual({
      status: 'qualified',
      primaryModel: 'minimax-portal/MiniMax-M3',
    });
  });

  test('keeps explicit server refs when a custom provider has the same model id', () => {
    expect(resolveQualifiedAgentModelRef({
      agentModel: 'lobsterai-server/kimi-k2.6',
      availableProviders: {
        moonshot: { models: [{ id: 'kimi-k2.6' }] },
      },
    })).toEqual({
      status: 'qualified',
      primaryModel: 'lobsterai-server/kimi-k2.6',
    });
  });
});
