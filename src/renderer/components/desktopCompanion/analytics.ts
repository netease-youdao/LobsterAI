import {
  CompanionAnalyticsAction, type CompanionAnalyticsEvent, CompanionAnalyticsOutcome,
  type CompanionAnalyticsSource, CompanionAnalyticsStage,
  CompanionTaskBlockedReason, type CompanionTaskFailure, CompanionTaskFailureCode, CompanionTaskFailureStage,
} from '../../../shared/desktopCompanion/analytics';
import type { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import { CoworkStartBlock } from '../cowork/coworkStartRequest';

export function companionPreflightFailure(block: CoworkStartBlock, phase?: OpenClawEnginePhase): CompanionTaskFailure {
  const failureStage = CompanionTaskFailureStage.Preflight;
  switch (block) {
    case CoworkStartBlock.EngineNotReady:
      return { failureCode: CompanionTaskFailureCode.EngineNotReady, failureStage, blockedReason: phase ?? CompanionTaskBlockedReason.Unknown };
    case CoworkStartBlock.EnterpriseQuota:
      return { failureCode: CompanionTaskFailureCode.Quota, failureStage, blockedReason: CompanionTaskBlockedReason.EnterpriseQuota };
    case CoworkStartBlock.ModelBillingSide:
      return { failureCode: CompanionTaskFailureCode.ModelBillingSide, failureStage, blockedReason: CompanionTaskBlockedReason.ModelBillingSide };
  }
}

/** Auxiliary surfaces do not initialize the main renderer's analytics identity. */
export function reportCompanionAnalytics(event: CompanionAnalyticsEvent): void {
  try {
    void window.electron.desktopCompanion.reportAnalytics(event).catch(() => {});
  } catch { /* Reporting must not affect task submission or file drops. */ }
}

export function beginCompanionTask(source: CompanionAnalyticsSource, isFollowUp = false): (success: boolean, failure?: CompanionTaskFailure) => void {
  const startedAt = Date.now();
  let finished = false;
  let callId: string | undefined;
  try { callId = crypto.randomUUID(); } catch { /* Retain uncorrelated reporting if UUID creation is unavailable. */ }
  reportCompanionAnalytics({ action: CompanionAnalyticsAction.Task, source, isFollowUp, callId, stage: CompanionAnalyticsStage.Submit });
  return (success, failure) => {
    if (finished) return;
    finished = true;
    reportCompanionAnalytics({ action: CompanionAnalyticsAction.Task, source, isFollowUp, callId, stage: CompanionAnalyticsStage.Result,
      outcome: success ? CompanionAnalyticsOutcome.Success : CompanionAnalyticsOutcome.Failed,
      ...(!success ? failure ?? { failureCode: CompanionTaskFailureCode.Unknown,
        failureStage: isFollowUp ? CompanionTaskFailureStage.SessionContinue : CompanionTaskFailureStage.SessionStart } : {}),
      durationMs: Math.max(0, Date.now() - startedAt) });
  };
}
