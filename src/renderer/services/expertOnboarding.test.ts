import { AgentSource } from '@shared/agent/constants';
import { ExpertFixtureId } from '@shared/agent/expertCatalogFixture';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId, setSidebarRevealAgentId } from '../store/slices/agentSlice';
import {
  clearCurrentSession,
  setDraftAttachments,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
  setDraftSkillIds,
  setSessions,
} from '../store/slices/coworkSlice';
import { setActiveKitIds } from '../store/slices/kitSlice';
import type { Agent } from '../types/agent';
import { CoworkCollaborationMode } from '../types/cowork';
import { agentService } from './agent';
import { openExpertDraft, switchExpertInDraft } from './expertOnboarding';

vi.mock('./cowork', () => ({
  coworkService: { clearSession: () => store.dispatch(clearCurrentSession()) },
}));

const expert: Agent = {
  id: 'expert-1', name: 'My edited expert', description: '', systemPrompt: 'My prompt', identity: '',
  model: 'provider/model', thinkingLevel: '', workingDirectory: '', icon: '', skillIds: ['docx'],
  subagentAllowAgentIds: [], enabled: true, pinned: false, isDefault: false, source: AgentSource.Preset,
  presetId: ExpertFixtureId.Data, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setSidebarRevealAgentId(null));
  vi.stubGlobal('window', { electron: { agents: { addPreset: vi.fn().mockResolvedValue(expert) } } });
});

afterEach(() => vi.unstubAllGlobals());

test('expert skill provenance survives draft sync and removal followed by re-selection becomes explicit', () => {
  const imageExpert = { ...expert, skillIds: ['canvas-design', 'seedream'] };
  openExpertDraft(imageExpert, 'Make an image');
  expect(store.getState().cowork.draftInheritedSkillIds.__home__).toEqual(imageExpert.skillIds);
  store.dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: [...imageExpert.skillIds, 'seedance'] }));
  expect(store.getState().cowork.draftInheritedSkillIds.__home__).toEqual(imageExpert.skillIds);
  store.dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: ['canvas-design'] }));
  store.dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: ['canvas-design', 'seedream'] }));
  expect(store.getState().cowork.draftInheritedSkillIds.__home__).toEqual(['canvas-design']);
  store.dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: [] }));
  expect(store.getState().cowork.draftInheritedSkillIds.__home__).toBeUndefined();
});

test('switching an installed expert carries the latest text and preserves draft context', () => {
  store.dispatch(setAgents([expert]));
  store.dispatch(setDraftPrompt({ sessionId: '__home__', draft: 'Stale debounced text' }));
  const attachments = [{ name: 'notes.txt', path: '/notes.txt' }];
  store.dispatch(setDraftAttachments({ draftKey: '__home__', attachments }));
  store.dispatch(setActiveKitIds(['my-kit']));
  store.dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: ['my-kit'] }));
  store.dispatch(setDraftCollaborationMode({ draftKey: '__home__', mode: CoworkCollaborationMode.Plan }));
  const sessions = store.getState().cowork.sessions;

  expect(switchExpertInDraft(expert.id, 'Latest text, not yet persisted')).toBe(true);

  const state = store.getState();
  expect(state.agent.currentAgentId).toBe(expert.id);
  expect(state.agent.sidebarRevealAgentId).toBe(expert.id);
  expect(state.cowork.currentSession).toBeNull();
  expect(state.cowork.sessions).toEqual(sessions);
  expect(state.cowork.draftPrompts.__home__).toBe('Latest text, not yet persisted');
  expect(state.cowork.draftAttachments.__home__).toEqual(attachments);
  expect(state.kit.activeKitIds).toEqual(['my-kit']);
  expect(state.cowork.draftKitIds.__home__).toEqual(['my-kit']);
  expect(state.cowork.draftCollaborationModes.__home__).toBe(CoworkCollaborationMode.Plan);
  expect(state.skill.activeSkillIds).toEqual(expert.skillIds);
  expect(state.cowork.draftSkillIds.__home__).toEqual(expert.skillIds);
});

test('a removed or disabled expert cannot change the active draft', () => {
  store.dispatch(setAgents([{ ...expert, enabled: false }]));
  const before = store.getState();
  expect(switchExpertInDraft(expert.id, 'Do not replace')).toBe(false);
  expect(switchExpertInDraft('missing-expert', 'Do not replace')).toBe(false);
  expect(store.getState()).toBe(before);
});

test('summoning the current expert again requests a new reveal after the sidebar consumed the first', () => {
  store.dispatch(setAgents([expert]));
  openExpertDraft(expert, 'First draft');
  store.dispatch(setSidebarRevealAgentId(null));

  openExpertDraft(expert, 'Another draft');
  expect(store.getState().agent.sidebarRevealAgentId).toBe(expert.id);
  expect(store.getState().cowork.draftPrompts.__home__).toBe('Another draft');

  store.dispatch(setSidebarRevealAgentId(null));
  expect(switchExpertInDraft(expert.id, 'Keep my draft')).toBe(true);
  expect(store.getState().agent.sidebarRevealAgentId).toBe(expert.id);
});

test('repeated preparation upserts the existing agent instead of duplicating it', async () => {
  await agentService.addPreset(expert.presetId);
  await agentService.addPreset(expert.presetId);
  expect(store.getState().agent.agents).toHaveLength(1);
  expect(store.getState().agent.agents[0]).toMatchObject({ name: expert.name, model: expert.model, skillIds: ['docx'] });
});

test('summon opens a clean expert draft without starting or stopping tasks', async () => {
  await agentService.addPreset(expert.presetId);
  const backgroundTask = { id: 'running-task', title: 'In progress', scheduledTaskId: null, status: 'running' as const, pinned: false, createdAt: 1, updatedAt: 1 };
  store.dispatch(setSessions([backgroundTask]));
  store.dispatch(setDraftPrompt({ sessionId: 'running-task', draft: 'Keep this task draft' }));
  store.dispatch(setDraftPrompt({ sessionId: '__home__', draft: 'An unrelated task' }));
  store.dispatch(setActiveKitIds(['previous-kit']));
  store.dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: ['previous-kit'] }));
  store.dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: ['previous-skill'] }));
  store.dispatch(setDraftCollaborationMode({ draftKey: '__home__', mode: CoworkCollaborationMode.Plan }));
  store.dispatch(setDraftAttachments({ draftKey: '__home__', attachments: [{ name: 'old.txt', path: '/old.txt' }] }));

  openExpertDraft(expert, 'Help me edit an article');

  const state = store.getState();
  expect(state.agent.currentAgentId).toBe(expert.id);
  expect(state.agent.sidebarRevealAgentId).toBe(expert.id);
  expect(state.cowork.currentSession).toBeNull();
  expect(state.cowork.sessions).toEqual([backgroundTask]);
  expect(state.cowork.draftPrompts['running-task']).toBe('Keep this task draft');
  expect(state.cowork.draftPrompts.__home__).toBe('Help me edit an article');
  expect(state.cowork.draftAttachments.__home__).toBeUndefined();
  expect(state.cowork.draftKitIds.__home__ ?? []).toEqual([]);
  expect(state.kit.activeKitIds).toEqual([]);
  expect(state.cowork.draftSkillIds.__home__).toEqual(expert.skillIds);
  expect(state.skill.activeSkillIds).toEqual(expert.skillIds);
  expect(state.cowork.draftCollaborationModes.__home__ ?? CoworkCollaborationMode.Default).toBe(CoworkCollaborationMode.Default);
});
