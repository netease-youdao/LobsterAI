import { usesInheritedAgentModel } from '@shared/agent/modelSelection';
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
import { i18nService } from './i18n';
import { prepareExpertAnalytics } from './usageAnalytics';

const EXPERT_HOME_DRAFT_KEY = '__home__';
let expertSwitchRequest = 0;

/** Change the role of a home draft without losing text, attachments or selected kits. */
export async function switchExpertInDraft(agentId: string, prompt: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  const request = ++expertSwitchRequest;
  const before = store.getState();
  const agent = before.agent.agents.find(item => item.id === agentId && item.enabled);
  if (!agent) return false;
  if (usesInheritedAgentModel(agent) && agent.presetId) {
    try {
      if (!await agentService.addPreset(agent.presetId)) return false;
    } catch (error) {
      console.error('[ExpertOnboarding] Failed to prepare inherited expert model:', error);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('expertSummonFailed') }));
      return false;
    }
    const after = store.getState();
    if (request !== expertSwitchRequest || !isCurrent()
      || after.agent.currentAgentId !== before.agent.currentAgentId
      || after.cowork.currentSessionId !== before.cowork.currentSessionId
      || after.auth.accountGeneration !== before.auth.accountGeneration) return false;
  }
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
  expertSwitchRequest += 1;
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
