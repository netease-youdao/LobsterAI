import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { setCurrentSession } from '../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import { type CoworkSession,CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';

const makeSession = (): CoworkSession => ({
  id: 'session-1',
  title: 'Session 1',
  claudeSessionId: null,
  scheduledTaskId: null,
  status: CoworkSessionStatusValue.Running,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'agent-1',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setCurrentSession(null));
  store.dispatch(clearActiveSkills());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('coworkService.clearSession', () => {
  test('restores the current agent default skills for a new task', () => {
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
      skillIds: ['docx', 'web-search'],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setCurrentSession(makeSession()));

    coworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['docx', 'web-search']);
  });

  test('does not change active skills for generic session clearing', () => {
    store.dispatch(setActiveSkillIds(['xlsx']));
    store.dispatch(setCurrentSession(makeSession()));

    coworkService.clearSession();

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['xlsx']);
  });

  test('clears active skills when the current agent has no default skills', () => {
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
    store.dispatch(setActiveSkillIds(['xlsx']));

    coworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().skill.activeSkillIds).toEqual([]);
  });

  test('does not restore a session whose load finishes after clearing', async () => {
    let resolveGetSession: ((value: { success: true; session: CoworkSession }) => void) | undefined;
    const getSession = vi.fn(() => new Promise<{ success: true; session: CoworkSession }>((resolve) => {
      resolveGetSession = resolve;
    }));
    const remoteManaged = vi.fn(async () => ({ remoteManaged: true }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          remoteManaged,
        },
      },
    });

    const pendingLoad = coworkService.loadSession('session-1');
    coworkService.clearSession();
    resolveGetSession?.({ success: true, session: makeSession() });
    await pendingLoad;

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().cowork.remoteManaged).toBe(false);
    expect(remoteManaged).not.toHaveBeenCalled();
  });
});
