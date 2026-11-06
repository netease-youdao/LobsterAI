import { randomUUID } from 'crypto';

import { isUsageId } from '../../shared/analytics/usage';
import {
  CompanionAnalyticsAction, CompanionAnalyticsInteraction as Interaction, CompanionAnalyticsSource, CompanionAnalyticsTool,
} from '../../shared/desktopCompanion/analytics';
import type { DesktopCompanionLoginStart } from '../../shared/desktopCompanion/constants';
import type { LanguageToolResume } from '../../shared/desktopCompanion/languageTools';
import type { CompanionAnalytics } from './companionAnalytics';

/** A sign-in that finishes later than this after the prompt's button is not credited to the prompt. */
export const COMPANION_LOGIN_ATTRIBUTION_MS = 30 * 60_000;
/** The longest follow-up question carried through a sign-in. */
const RESUME_QUESTION_MAX_CHARS = 4_000;

export type CompanionLoginSource = typeof CompanionAnalyticsSource.Selection | typeof CompanionAnalyticsSource.LanguageTools;

/** Only the selection and language tools cards show the sign-in prompt. */
export function isCompanionLoginSource(source: CompanionAnalyticsSource): source is CompanionLoginSource {
  return source === CompanionAnalyticsSource.Selection || source === CompanionAnalyticsSource.LanguageTools;
}

/** Keeps a known tool, an analytics ID and a bounded resume request; drops everything else from the renderer. */
export function normalizeCompanionLoginStart(value: unknown): DesktopCompanionLoginStart | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const tool = Object.values(CompanionAnalyticsTool).find(item => item === input.tool);
  if (!tool) return null;
  const raw = input.resume && typeof input.resume === 'object' ? input.resume as Record<string, unknown> : null;
  const question = typeof raw?.question === 'string'
    ? [...raw.question.trim()].slice(0, RESUME_QUESTION_MAX_CHARS).join('')
    : '';
  const resume: LanguageToolResume | undefined = question ? { question } : undefined;
  return {
    tool,
    ...(isUsageId(input.journeyId) ? { journeyId: input.journeyId } : {}),
    ...(resume ? { resume } : {}),
  };
}

interface PendingLogin {
  source: CompanionLoginSource;
  tool: DesktopCompanionLoginStart['tool'];
  journeyId: string;
  startedAt: number;
}

/** Connects a companion sign-in prompt to the sign-in it opened. The newest prompt wins. */
export class CompanionLoginTracker {
  private pending: PendingLogin | null = null;

  constructor(
    private readonly analytics: Pick<CompanionAnalytics, 'report'>,
    private readonly now: () => number = Date.now,
  ) {}

  begin(source: CompanionLoginSource, request: DesktopCompanionLoginStart): void {
    const journeyId = request.journeyId ?? randomUUID();
    this.pending = { source, tool: request.tool, journeyId, startedAt: this.now() };
    this.analytics.report({
      action: CompanionAnalyticsAction.Action, source, interactionType: Interaction.LoginClick, tool: request.tool, journeyId,
    });
  }

  /** Reports the sign-in when a prompt opened it recently, and returns whether one did. */
  succeed(): boolean {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return false;
    const durationMs = Math.max(0, this.now() - pending.startedAt);
    if (durationMs > COMPANION_LOGIN_ATTRIBUTION_MS) return false;
    this.analytics.report({
      action: CompanionAnalyticsAction.Action, source: pending.source, interactionType: Interaction.LoginSuccess,
      tool: pending.tool, journeyId: pending.journeyId, durationMs,
    });
    return true;
  }
}
