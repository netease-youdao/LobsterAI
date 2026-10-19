import {
  CompanionAnalyticsAction, type CompanionAnalyticsEvent, CompanionAnalyticsOutcome,
  type CompanionAnalyticsSource, CompanionAnalyticsStage,
} from '../../../shared/desktopCompanion/analytics';

/** Auxiliary surfaces do not initialize the main renderer's analytics identity. */
export function reportCompanionAnalytics(event: CompanionAnalyticsEvent): void {
  try {
    void window.electron.desktopCompanion.reportAnalytics(event).catch(() => {});
  } catch { /* Reporting must not affect task submission or file drops. */ }
}

export function beginCompanionTask(source: CompanionAnalyticsSource, isFollowUp = false): (success: boolean) => void {
  const startedAt = Date.now();
  let finished = false;
  let callId: string | undefined;
  try { callId = crypto.randomUUID(); } catch { /* Retain uncorrelated reporting if UUID creation is unavailable. */ }
  reportCompanionAnalytics({ action: CompanionAnalyticsAction.Task, source, isFollowUp, callId, stage: CompanionAnalyticsStage.Submit });
  return success => {
    if (finished) return;
    finished = true;
    reportCompanionAnalytics({ action: CompanionAnalyticsAction.Task, source, isFollowUp, callId, stage: CompanionAnalyticsStage.Result,
      outcome: success ? CompanionAnalyticsOutcome.Success : CompanionAnalyticsOutcome.Failed,
      durationMs: Math.max(0, Date.now() - startedAt) });
  };
}
