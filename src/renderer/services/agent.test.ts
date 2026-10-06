import {
  AgentLegacyIdentityCleanupSkipReason,
  AgentLegacyIdentityCleanupStatus,
} from '@shared/agent';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { clearCurrentSession } from '../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent } from '../types/agent';
import { agentService } from './agent';

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'Agent 1',
  description: '',
  systemPrompt: '',
  identity: '',
  model: '',
  thinkingLevel: '',
  workingDirectory: '',
  icon: '',
  skillIds: [],
  subagentAllowAgentIds: [],
  enabled: true,
  pinned: false,
  pinOrder: null,
  isDefault: false,
  source: 'custom',
  presetId: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(clearCurrentSession());
  store.dispatch(clearActiveSkills());
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

describe('agentService.updateAgent', () => {
  test('refreshes active skills when the current agent is saved', async () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      icon: '',
      model: '',
      thinkingLevel: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: [],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));

    (globalThis as { window?: unknown }).window = {
      electron: {
        agents: {
          update: vi.fn().mockResolvedValue(makeAgent({ skillIds: ['docx', 'web-search'] })),
        },
      },
    };

    await agentService.updateAgent('agent-1', { skillIds: ['docx', 'web-search'] });

    expect(store.getState().agent.agents[0].skillIds).toEqual(['docx', 'web-search']);
    expect(store.getState().skill.activeSkillIds).toEqual(['docx', 'web-search']);
  });

  test('persists model and thinking level together without clearing active skills', async () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      icon: '',
      model: '',
      thinkingLevel: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: [],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setActiveSkillIds(['user-selected-skill']));

    (globalThis as { window?: unknown }).window = {
      electron: {
        agents: {
          update: vi.fn().mockResolvedValue(makeAgent({
            model: 'new-model',
            thinkingLevel: 'max',
            skillIds: [],
          })),
        },
      },
    };

    await agentService.updateAgent('agent-1', {
      model: 'new-model',
      thinkingLevel: 'max',
    });

    // Active skills should remain untouched since skillIds was not in the update
    expect(store.getState().agent.agents[0].thinkingLevel).toBe('max');
    expect(store.getState().skill.activeSkillIds).toEqual(['user-selected-skill']);
  });

  test('does not replace active skills when another agent is saved', async () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      icon: '',
      model: '',
      thinkingLevel: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: ['docx'],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-2'));
    store.dispatch(setActiveSkillIds(['xlsx']));

    (globalThis as { window?: unknown }).window = {
      electron: {
        agents: {
          update: vi.fn().mockResolvedValue(makeAgent({ skillIds: ['docx', 'web-search'] })),
        },
      },
    };

    await agentService.updateAgent('agent-1', { skillIds: ['docx', 'web-search'] });

    expect(store.getState().skill.activeSkillIds).toEqual(['xlsx']);
  });
});

describe('agentService.switchAgent', () => {
  test('preserves the target conversation presentation during a cross-agent session switch', () => {
    store.dispatch(setAgents([makeAgent({ id: 'agent-2' })]));

    agentService.switchAgent('agent-2', { targetSessionId: 'session-2' });

    expect(store.getState().agent.currentAgentId).toBe('agent-2');
    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().cowork.sessionNavigationTargetId).toBe('session-2');
  });

  test('clears a stale navigation target for a plain agent switch', () => {
    store.dispatch(clearCurrentSession({ sessionNavigationTargetId: 'session-2' }));

    agentService.switchAgent('main');

    expect(store.getState().cowork.sessionNavigationTargetId).toBeNull();
  });
});

describe('agentService.cleanupLegacyIdentityBlock', () => {
  test('delegates cleanup to the preload agents API', async () => {
    const cleanupLegacyIdentityBlock = vi.fn().mockResolvedValue({
      status: AgentLegacyIdentityCleanupStatus.Skipped,
      reason: AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock,
    });
    (globalThis as { window?: unknown }).window = {
      electron: {
        agents: {
          cleanupLegacyIdentityBlock,
        },
      },
    };

    const result = await agentService.cleanupLegacyIdentityBlock('agent-1');

    expect(cleanupLegacyIdentityBlock).toHaveBeenCalledWith('agent-1');
    expect(result).toEqual({
      status: AgentLegacyIdentityCleanupStatus.Skipped,
      reason: AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock,
    });
  });

  test('returns failed when cleanup API is unavailable', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        agents: {},
      },
    };

    const result = await agentService.cleanupLegacyIdentityBlock('agent-1');

    expect(result.status).toBe(AgentLegacyIdentityCleanupStatus.Failed);
  });
});
