/**
 * Adapted from OpenClaw v2026.8.1 ui/src/components/session-progress-card.ts
 * (MIT, see third-party-notices/openclaw-progress-card-LICENSE.txt) by way of
 * netease-youdao/LobsterAI#2758. The Gateway's card stays authoritative.
 */
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  PauseCircleIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useId, useState } from 'react';

import { type OpenClawProgressCard as ProgressCard, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionStatus } from '../../types/cowork';
import {
  getProgressCardOutcome,
  getProgressCardSummary,
  ProgressCardOutcome,
} from './progressCardDisplay';
import ProgressCardMarkdown from './ProgressCardMarkdown';
import { useOpenClawProgressCard } from './useOpenClawProgressCard';

const OUTCOME_LABEL_KEYS: Partial<Record<ProgressCardOutcome, string>> = {
  [ProgressCardOutcome.TurnEnded]: 'progressCardTurnEnded',
  [ProgressCardOutcome.Stopped]: 'progressCardStopped',
  [ProgressCardOutcome.Failed]: 'progressCardFailed',
};

const UPDATED_TIME_TICK_MS = 30_000;

const formatUpdatedAt = (updatedAt: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return i18nService.t('progressCardUpdatedJustNow');
  if (minutes < 60) return i18nService.t('progressCardUpdatedMinutes').replace('{count}', String(minutes));
  if (minutes < 24 * 60) {
    return i18nService.t('progressCardUpdatedHours').replace('{count}', String(Math.floor(minutes / 60)));
  }
  return i18nService.t('progressCardUpdatedAt').replace(
    '{time}',
    new Date(updatedAt).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US'),
  );
};

const Spinner: React.FC = () => (
  <span
    className="block h-[1em] w-[1em] animate-spin rounded-full border-[1.5px] border-border border-t-secondary motion-reduce:animate-none"
    aria-hidden="true"
  />
);

const StepMarker: React.FC<{ status: ProgressCardStepStatus; outcome: ProgressCardOutcome }> = ({ status, outcome }) => {
  if (status === ProgressCardStepStatus.Completed) {
    return <CheckIcon className="h-[1em] w-[1em] text-green-600 dark:text-green-400" />;
  }
  if (status === ProgressCardStepStatus.InProgress) {
    if (outcome === ProgressCardOutcome.Running) return <Spinner />;
    if (outcome === ProgressCardOutcome.Failed) return <XCircleIcon className="h-[1em] w-[1em] text-red-500/80" />;
    return <PauseCircleIcon className="h-[1em] w-[1em] text-muted" />;
  }
  return <ClockIcon className="h-[1em] w-[1em] text-muted" />;
};

/**
 * The agent's progress card as a tab attached to the top of the composer,
 * like the goal status bar: one line — the step being worked on, its
 * position, and how the run stands — that opens onto the note and the whole
 * checklist. It starts open while the agent works on it and closed
 * otherwise; the user's own toggle wins after that. A card the agent is no
 * longer working on can be closed, which clears it in the Gateway.
 */
export const OpenClawProgressCardView: React.FC<{
  card: ProgressCard;
  sessionStatus: CoworkSessionStatus;
  /** The composer is in its compact size (artifact panel open). */
  compact?: boolean;
  onDismiss?: () => void;
}> = ({ card, sessionStatus, compact = false, onDismiss }) => {
  const summary = getProgressCardSummary(card);
  const outcome = getProgressCardOutcome(summary, sessionStatus);
  const [expandedByUser, setExpandedByUser] = useState<boolean | null>(null);
  const isExpanded = expandedByUser ?? outcome === ProgressCardOutcome.Running;
  const [now, setNow] = useState(() => Date.now());
  const bodyId = useId();

  useEffect(() => {
    if (!isExpanded) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), UPDATED_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isExpanded]);

  const steps = card.steps ?? [];
  const headline = summary.isComplete
    ? i18nService.t('progressCardAllDone').replace('{total}', String(summary.total))
    : summary.currentStep ?? summary.note ?? '';
  const outcomeLabelKey = OUTCOME_LABEL_KEYS[outcome];
  const meta = [
    summary.total > 0 && !summary.isComplete
      ? i18nService.t('progressCardPosition')
        .replace('{current}', String(summary.position))
        .replace('{total}', String(summary.total))
      : null,
    outcomeLabelKey ? i18nService.t(outcomeLabelKey) : null,
    isExpanded ? formatUpdatedAt(card.updatedAt, now) : null,
  ].filter(Boolean).join(' · ');
  const canDismiss = Boolean(onDismiss) && outcome !== ProgressCardOutcome.Running;

  const leadingIcon = outcome === ProgressCardOutcome.Running
    ? <Spinner />
    : outcome === ProgressCardOutcome.Complete
      ? <CheckIcon className="h-[1em] w-[1em] text-green-600 dark:text-green-400" />
      : <ClipboardDocumentListIcon className="h-[1em] w-[1em]" />;

  return (
    <section
      className={`${compact ? 'mx-3' : 'mx-5'} overflow-hidden rounded-t-2xl border border-b-0 border-border bg-surface-raised/60 text-xs text-secondary`}
      aria-label={i18nService.t('progressCardTitle')}
      data-progress-card={outcome}
    >
      <div className="flex min-w-0 items-center gap-1 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpandedByUser(!isExpanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={isExpanded}
          aria-controls={bodyId}
        >
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm" aria-hidden="true">
            {leadingIcon}
          </span>
          <span className="flex-shrink-0 font-semibold text-foreground">{i18nService.t('progressCardTitle')}</span>
          <span className="min-w-0 flex-1 truncate">{isExpanded ? '' : headline}</span>
          {meta && <span className="flex-shrink-0 tabular-nums text-muted">{meta}</span>}
          <ChevronRightIcon
            className={`h-3.5 w-3.5 flex-shrink-0 text-muted transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </button>
        {canDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="flex-shrink-0 rounded-md p-1 text-secondary transition-colors hover:bg-surface hover:text-foreground"
            title={i18nService.t('progressCardDismiss')}
            aria-label={i18nService.t('progressCardDismiss')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {isExpanded && (
        <div
          id={bodyId}
          className="max-h-[min(280px,35vh)] overflow-y-auto overscroll-contain px-3 pb-2.5 [overflow-wrap:anywhere]"
          data-progress-card-body
        >
          {card.markdown && <ProgressCardMarkdown content={card.markdown} />}
          {steps.length > 0 && (
            <ol className="mt-1 space-y-1">
              {steps.map((step, index) => (
                <li
                  key={`${index}-${step.step}`}
                  className={`flex items-start gap-2 leading-5 ${
                    step.status === ProgressCardStepStatus.InProgress
                      ? 'text-foreground'
                      : step.status === ProgressCardStepStatus.Completed ? 'text-muted' : 'text-secondary'
                  }`}
                  data-status={step.status}
                >
                  <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center text-sm" aria-hidden="true">
                    <StepMarker status={step.status} outcome={outcome} />
                  </span>
                  <span className="min-w-0">{step.step}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
};

/** The current session's native progress card, above the composer; nothing when it has none. */
const OpenClawProgressCard: React.FC<{
  sessionId: string;
  sessionStatus: CoworkSessionStatus;
  compact?: boolean;
}> = ({ sessionId, sessionStatus, compact }) => {
  const { card, dismiss } = useOpenClawProgressCard(sessionId);
  if (!card) return null;
  return (
    <div className="relative z-10 -mb-px">
      <OpenClawProgressCardView
        card={card}
        sessionStatus={sessionStatus}
        compact={compact}
        onDismiss={() => void dismiss(card.revision)}
      />
    </div>
  );
};

export default OpenClawProgressCard;
