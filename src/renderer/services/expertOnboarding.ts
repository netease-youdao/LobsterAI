import { UsageEntry } from '@shared/analytics/usage';

import { store } from '../store';
import { setSidebarRevealAgentId } from '../store/slices/agentSlice';
import {
  clearDraftAttachments,
  clearDraftBrowserAnnotationBatches,
  clearDraftSelectedTextSnippets,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
  setDraftSkillIds,
} from '../store/slices/coworkSlice';
import { clearActiveKits } from '../store/slices/kitSlice';
import { clearSelection } from '../store/slices/quickActionSlice';
import type { Agent } from '../types/agent';
import { CoworkCollaborationMode } from '../types/cowork';
import { agentService } from './agent';
import { coworkService } from './cowork';
import { prepareExpertAnalytics } from './usageAnalytics';

const EXPERT_HOME_DRAFT_KEY = '__home__';

/** Change the role of a home draft without losing text, attachments or selected kits. */
export function switchExpertInDraft(agentId: string, prompt: string): boolean {
  const agent = store.getState().agent.agents.find(item => item.id === agentId && item.enabled);
  if (!agent) return false;
  coworkService.clearSession();
  agentService.switchAgent(agent.id);
  store.dispatch(setSidebarRevealAgentId(agent.id));
  store.dispatch(setDraftSkillIds({ draftKey: EXPERT_HOME_DRAFT_KEY, skillIds: agent.skillIds, inheritedSkillIds: agent.skillIds }));
  store.dispatch(setDraftPrompt({ sessionId: EXPERT_HOME_DRAFT_KEY, draft: prompt }));
  prepareExpertAnalytics(agent.id, agent.presetId, { entry: UsageEntry.Picker });
  return true;
}

/** Prepare a fresh draft only. Creating a session remains an explicit user action. */
export function openExpertDraft(agent: Agent, prompt: string): void {
  coworkService.clearSession(); // Invalidate any outstanding session navigation.
  agentService.switchAgent(agent.id);
  store.dispatch(setSidebarRevealAgentId(agent.id));
  store.dispatch(clearSelection());
  store.dispatch(clearActiveKits());
  store.dispatch(clearDraftAttachments(EXPERT_HOME_DRAFT_KEY));
  store.dispatch(clearDraftSelectedTextSnippets(EXPERT_HOME_DRAFT_KEY));
  store.dispatch(clearDraftBrowserAnnotationBatches(EXPERT_HOME_DRAFT_KEY));
  store.dispatch(setDraftKitIds({ draftKey: EXPERT_HOME_DRAFT_KEY, kitIds: [] }));
  store.dispatch(setDraftSkillIds({ draftKey: EXPERT_HOME_DRAFT_KEY, skillIds: agent.skillIds, inheritedSkillIds: agent.skillIds }));
  store.dispatch(setDraftCollaborationMode({ draftKey: EXPERT_HOME_DRAFT_KEY, mode: CoworkCollaborationMode.Default }));
  store.dispatch(setDraftPrompt({ sessionId: EXPERT_HOME_DRAFT_KEY, draft: prompt }));
}
