import { randomUUID } from 'crypto';

import { isUsageId, readUsageContext, UsageAnalytics, type UsageContext } from '../../shared/analytics/usage';
import {
  CompanionAnalyticsAction, type CompanionAnalyticsEvent, CompanionAnalyticsOutcome,
  CompanionAnalyticsSetting, CompanionAnalyticsSource, CompanionAnalyticsStage, normalizeCompanionAnalyticsEvent,
} from '../../shared/desktopCompanion/analytics';
import type { DesktopCompanionPreferences } from '../../shared/desktopCompanion/constants';
import type { MainLogEventParams } from '../libs/mainLogReporter';

export type CompanionAnalyticsReporter = (event: MainLogEventParams) => void | Promise<unknown>;

/** All auxiliary windows use the main reporter's current identity and opt-out. */
export class CompanionAnalytics {
  private readonly tasks = new Map<string, {
    owner: string; senderId: number; source: CompanionAnalyticsSource; journeyId: string;
    isFollowUp: boolean; dispatched: boolean; finished: boolean; context?: UsageContext;
  }>();

  constructor(private readonly reporter?: CompanionAnalyticsReporter, private readonly getOwner: () => string | null = () => '') {}

  report = (input: CompanionAnalyticsEvent): void => {
    const event = normalizeCompanionAnalyticsEvent(input);
    if (!event) return;
    try {
      void Promise.resolve(this.reporter?.({ ...event })).catch(() => {});
    } catch { /* Analytics must never interrupt a companion interaction. */ }
  };

  clearTasks(): void { this.tasks.clear(); }

  /** Called at Cowork IPC entry, before awaits; the callback captures the dispatched turn synchronously. */
  captureTask(senderId: number): (context?: UsageContext) => void {
    const pending = [...this.tasks.values()].reverse().find(item => item.senderId === senderId && !item.finished && !item.dispatched);
    if (!pending) return () => {};
    pending.dispatched = true;
    return context => {
      try {
        if (!pending.finished && pending.owner === this.getOwner()) pending.context = readUsageContext(context);
      } catch { /* Missing attribution must not affect runtime dispatch. */ }
    };
  }

  task(input: CompanionAnalyticsEvent, senderId: number, source: CompanionAnalyticsSource, journeyId?: string): void {
    try {
      const event = normalizeCompanionAnalyticsEvent(input);
      if (!event || event.action !== CompanionAnalyticsAction.Task) return;
      // Keep older senders usable, without guessing a task association.
      if (!event.callId) {
        this.report({ ...event, source, taskId: undefined, turnId: undefined, journeyId: undefined });
        return;
      }
      const owner = this.getOwner();
      if (owner === null) { this.clearTasks(); return; }
      if (event.stage === CompanionAnalyticsStage.Submit) {
        if (this.tasks.has(event.callId)) return;
        this.tasks.set(event.callId, { owner, senderId, source,
          journeyId: isUsageId(journeyId) ? journeyId : randomUUID(),
          isFollowUp: event.isFollowUp === true, dispatched: false, finished: false });
        while (this.tasks.size > UsageAnalytics.MaxTrackedItems) this.tasks.delete(this.tasks.keys().next().value!);
      }
      const pending = this.tasks.get(event.callId);
      if (!pending || pending.finished || pending.owner !== owner || pending.senderId !== senderId || pending.source !== source) return;
      let context: UsageContext | undefined;
      if (event.stage === CompanionAnalyticsStage.Result) {
        pending.finished = true;
        context = pending.context;
        if (event.outcome === CompanionAnalyticsOutcome.Failed) {
          console.warn('[DesktopCompanion] Task submission failed', {
            callId: event.callId, source, failureStage: event.failureStage, failureCode: event.failureCode,
            blockedReason: event.blockedReason, durationMs: event.durationMs,
            taskId: context?.taskId, turnId: context?.turnId,
          });
        }
      } else if (event.stage !== CompanionAnalyticsStage.Submit) return;
      this.report({ ...event, source, journeyId: pending.journeyId, isFollowUp: pending.isFollowUp,
        taskId: context?.taskId, turnId: context?.turnId });
    } catch { /* Correlation is optional and must never affect task submission. */ }
  }

  preferences(previous: DesktopCompanionPreferences, next: DesktopCompanionPreferences, source: CompanionAnalyticsSource): void {
    for (const setting of Object.values(CompanionAnalyticsSetting)) {
      if (JSON.stringify(previous[setting]) === JSON.stringify(next[setting])) continue;
      this.report({
        action: CompanionAnalyticsAction.SettingChanged, source, setting,
        ...(typeof next[setting] === 'boolean' ? { enabled: next[setting] as boolean } : {}),
        ...(setting === CompanionAnalyticsSetting.Shortcut ? { hasShortcut: !!next.shortcut } : {}),
        ...(setting === CompanionAnalyticsSetting.Skin ? { skin: next.skin } : {}),
        ...(setting === CompanionAnalyticsSetting.ExcludedApps ? { excludedAppCount: next.selectionExcludedApps.length } : {}),
      });
    }
  }

  tool(fields: Pick<CompanionAnalyticsEvent, 'source' | 'tool' | 'isFollowUp'>): (outcome: CompanionAnalyticsOutcome, reason?: CompanionAnalyticsEvent['reason']) => void {
    const startedAt = Date.now();
    let finished = false;
    this.report({ action: CompanionAnalyticsAction.Tool, ...fields, stage: CompanionAnalyticsStage.Submit });
    return (outcome, reason) => {
      if (finished) return;
      finished = true;
      this.report({ action: CompanionAnalyticsAction.Tool, ...fields, stage: CompanionAnalyticsStage.Result,
        outcome, reason, durationMs: Math.max(0, Date.now() - startedAt) });
    };
  }
}
