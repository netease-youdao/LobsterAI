import { CompanionTaskFailureStage } from '../../../shared/desktopCompanion/analytics';
import { CoworkSessionStatusValue } from '../../types/cowork';

export interface FollowUpResponse { success: boolean; error?: string; code?: string }

interface FollowUpApi {
  getSession(sessionId: string): Promise<FollowUpResponse & { session?: { status: string } }>;
  stopSession(sessionId: string): Promise<FollowUpResponse>;
  continueSession(options: { sessionId: string; prompt: string }): Promise<FollowUpResponse>;
}

/** Match the main window's queued follow-up action: interrupt, then submit a persisted user turn. */
export async function submitCompanionFollowUp(
  api: FollowUpApi,
  sessionId: string,
  text: string,
  onContinuing?: () => void,
  onStage?: (stage: CompanionTaskFailureStage) => void,
): Promise<FollowUpResponse> {
  const prompt = text.trim();
  if (!prompt) return { success: false };
  onStage?.(CompanionTaskFailureStage.SessionLookup);
  const current = await api.getSession(sessionId);
  if (!current.success || !current.session) return { success: false, error: current.error };
  if (current.session.status === CoworkSessionStatusValue.Running) {
    onStage?.(CompanionTaskFailureStage.SessionStop);
    const stopped = await api.stopSession(sessionId);
    if (!stopped.success) return stopped;
  }
  // Subscribe only after the interrupted turn has stopped, but before the new
  // turn can emit messages or finish (including before the IPC reply arrives).
  onContinuing?.();
  onStage?.(CompanionTaskFailureStage.SessionContinue);
  return api.continueSession({ sessionId, prompt });
}
