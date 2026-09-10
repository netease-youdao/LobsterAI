import { beforeEach, expect, test, vi } from 'vitest';

import { accountBoundRequest } from '../services/accountBoundRequest';
import { store } from './index';
import { setAgents, setCurrentAgentId } from './slices/agentSlice';
import { setLoggedIn, setLoggedOut } from './slices/authSlice';
import { setDraftPrompt } from './slices/coworkSlice';
import { setActiveSkillIds } from './slices/skillSlice';

const login = (ownerAccountKey: string) => store.dispatch(setLoggedIn({
  ownerAccountKey, user: { yid: ownerAccountKey, nickname: ownerAccountKey, avatarUrl: null }, quota: null,
}));

beforeEach(() => { store.dispatch(setLoggedOut()); vi.restoreAllMocks(); });

test('switching accounts clears private drafts, Agents and active skills synchronously', () => {
  login('A');
  store.dispatch(setAgents([{ id: 'a', name: 'Private', description: '', icon: '', model: '', thinkingLevel: '',
    workingDirectory: '/private-a', enabled: true, pinned: false, pinOrder: null, isDefault: false,
    source: 'custom', skillIds: [], subagentAllowAgentIds: [] }]));
  store.dispatch(setCurrentAgentId('a'));
  store.dispatch(setDraftPrompt({ sessionId: 'session-a', draft: 'Private draft' }));
  store.dispatch(setActiveSkillIds(['private-selection']));
  const config = store.getState().cowork.config;
  login('B');
  expect(store.getState().agent.agents).toEqual([]);
  expect(store.getState().agent.currentAgentId).toBe('main');
  expect(store.getState().cowork.draftPrompts).toEqual({});
  expect(store.getState().skill.activeSkillIds).toEqual([]);
  expect(store.getState().cowork.config).toBe(config);
});

test('same-account token refresh preserves drafts; logout clears them', () => {
  login('A');
  store.dispatch(setDraftPrompt({ sessionId: 'session-a', draft: 'Draft' }));
  login('A');
  expect(store.getState().cowork.draftPrompts['session-a']).toBe('Draft');
  store.dispatch(setLoggedOut());
  expect(store.getState().cowork.draftPrompts).toEqual({});
});

test('an IPC response from the previous account cannot refill the current view', async () => {
  login('A');
  let complete!: (value: string) => void;
  const response = accountBoundRequest(() => new Promise<string>(resolve => { complete = resolve; }));
  login('B');
  complete('Private A response');
  await expect(response).rejects.toThrow(/账号|account/);
});

test('unknown Agent identifiers cannot become the active Agent', () => {
  store.dispatch(setCurrentAgentId('not-visible'));
  expect(store.getState().agent.currentAgentId).toBe('main');
});
