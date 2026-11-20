import { AgentId } from '@shared/agent';

import { CoworkUiEvent } from '../components/cowork/constants';
import { store } from '../store';
import { agentService } from './agent';
import { coworkService } from './cowork';
import { i18nService } from './i18n';
import { SessionHistoryDirection, SessionNavigationHistory } from './sessionNavigationHistory';

/** MouseEvent.button values of the side buttons most mice map to back and forward. */
const MouseButton = {
  Back: 3,
  Forward: 4,
} as const;

/** The history step a mouse side button asks for, or null for any other button. */
export const getMouseButtonHistoryDirection = (button: number): SessionHistoryDirection | null => {
  if (button === MouseButton.Back) return SessionHistoryDirection.Back;
  if (button === MouseButton.Forward) return SessionHistoryDirection.Forward;
  return null;
};

/**
 * Back/forward between viewed sessions, driven by trackpad swipes, mouse
 * back/forward buttons and anything else that asks for a step.
 */
class SessionNavigationService {
  private readonly history = new SessionNavigationHistory();
  private navigating = false;

  /** Starts recording viewed sessions; returns the unsubscribe function. */
  start(): () => void {
    let lastSessionId: string | null | undefined;
    const record = () => {
      const state = store.getState();
      const session = state.cowork.currentSession;
      const sessionId = session?.id ?? null;
      if (sessionId === lastSessionId) return;
      lastSessionId = sessionId;
      this.history.observe(sessionId, session?.agentId?.trim() || state.agent.currentAgentId || AgentId.Main);
    };
    record();
    return store.subscribe(record);
  }

  canNavigate(direction: SessionHistoryDirection): boolean {
    if (this.navigating) return false;
    return this.history.canNavigate(direction, store.getState().cowork.currentSession?.id ?? null);
  }

  /** Opens the session one step back or forward; resolves to whether it opened. */
  async navigate(direction: SessionHistoryDirection): Promise<boolean> {
    if (this.navigating) return false;
    const targetIndex = this.history.resolveTargetIndex(
      direction,
      store.getState().cowork.currentSession?.id ?? null,
    );
    if (targetIndex === null) return false;
    const entry = this.history.beginNavigation(targetIndex);
    if (!entry) return false;

    this.navigating = true;
    let opened = false;
    try {
      if (entry.agentId !== store.getState().agent.currentAgentId) {
        agentService.switchAgent(entry.agentId, { targetSessionId: entry.sessionId });
        await coworkService.loadSessions(entry.agentId);
      }
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.SelectSubagent, { detail: null }));
      opened = Boolean(await coworkService.loadSession(entry.sessionId));
      if (!opened) {
        // The session is gone (deleted, or its agent removed); stop offering it.
        console.warn(`[SessionNavigation] could not open session ${entry.sessionId} going ${direction}; dropped it from history.`);
        this.history.remove(entry.sessionId);
      }
    } catch (error) {
      console.error(`[SessionNavigation] failed to go ${direction} to session ${entry.sessionId}.`, error);
    } finally {
      coworkService.finishSessionNavigation(entry.sessionId);
      this.navigating = false;
    }
    if (!opened) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('sidebarTaskOpenFailed'),
      }));
    }
    return opened;
  }
}

export const sessionNavigationService = new SessionNavigationService();
