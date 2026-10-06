/**
 * Adapted from OpenClaw v2026.8.1 ui/src/components/session-progress-card.ts
 * (MIT, see third-party-notices/openclaw-progress-card-LICENSE.txt) by way of
 * netease-youdao/LobsterAI#2758. The Gateway's card stays authoritative.
 */
import { ChevronUpIcon, ClipboardDocumentListIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { type OpenClawProgressCard as ProgressCard, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { i18nService } from '../../services/i18n';
import { readProgressCardExpanded, rememberProgressCardExpanded } from '../../services/progressCardExpansion';
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

/** Header glyph color for how the run stands. */
const OUTCOME_TONE_CLASSES: Record<ProgressCardOutcome, string> = {
  [ProgressCardOutcome.Running]: 'text-primary',
  [ProgressCardOutcome.Complete]: 'text-success',
  [ProgressCardOutcome.TurnEnded]: 'text-secondary',
  [ProgressCardOutcome.Stopped]: 'text-secondary',
  [ProgressCardOutcome.Failed]: 'text-destructive',
};

const STEP_TEXT_CLASSES: Record<ProgressCardStepStatus, string> = {
  [ProgressCardStepStatus.Completed]: 'text-muted line-through decoration-muted/60',
  [ProgressCardStepStatus.InProgress]: 'font-medium text-foreground',
  [ProgressCardStepStatus.Pending]: 'text-secondary',
};

const UPDATED_TIME_TICK_MS = 30_000;
// The pie is a stroke as wide as the circle it traces, so it fills a disc of twice this radius.
const PIE_RADIUS = 2.5;
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;

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

/** All glyphs share a 16-unit box so the header icon and step markers line up in one column. */
const Glyph: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <svg viewBox="0 0 16 16" className={`block ${className}`} aria-hidden="true">
    {children}
  </svg>
);

const Spinner: React.FC<{ className?: string }> = ({ className = '' }) => (
  <Glyph className={`animate-spin motion-reduce:animate-none ${className}`}>
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.75" opacity="0.2" />
    <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </Glyph>
);

/** The share of finished steps as a pie inside a ring, filling clockwise from twelve o'clock. */
const ProgressPie: React.FC<{ fraction: number; className?: string }> = ({ fraction, className = '' }) => (
  <Glyph className={className}>
    <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
    {fraction > 0 && (
      <circle
        cx="8"
        cy="8"
        r={PIE_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={PIE_RADIUS * 2}
        strokeDasharray={`${fraction * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dasharray] duration-500 ease-out"
      />
    )}
  </Glyph>
);

const CheckBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <Glyph className={className}>
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path
      d="M5.25 8.25 7.1 10.1 10.75 6.25"
      fill="none"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="stroke-surface"
    />
  </Glyph>
);

const StepMarker: React.FC<{ status: ProgressCardStepStatus; outcome: ProgressCardOutcome }> = ({ status, outcome }) => {
  const size = 'h-3.5 w-3.5';
  if (status === ProgressCardStepStatus.Completed) {
    return <CheckBadge className={`${size} text-muted`} />;
  }
  if (status === ProgressCardStepStatus.Pending) {
    return (
      <Glyph className={`${size} text-muted`}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </Glyph>
    );
  }
  if (outcome === ProgressCardOutcome.Running) {
    return <Spinner className={`${size} text-primary`} />;
  }
  if (outcome === ProgressCardOutcome.Failed) {
    return (
      <Glyph className={`${size} text-destructive`}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4.75v3.75" fill="none" strokeWidth="1.6" strokeLinecap="round" className="stroke-surface" />
        <circle cx="8" cy="11" r="0.9" className="fill-surface" />
      </Glyph>
    );
  }
  // Started but no longer being worked on: half full.
  return (
    <Glyph className={`${size} text-secondary`}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
    </Glyph>
  );
};

/**
 * The agent's progress card as a tab attached to the top of the composer,
 * like the goal status bar: one line — the step being worked on, its
 * position, and how the run stands — that opens onto the note and the whole
 * checklist. Whether it is open is up to the user alone (see
 * progressCardExpansion). A card the agent is no longer working on can be
 * closed, which clears it in the Gateway.
 */
export const OpenClawProgressCardView: React.FC<{
  card: ProgressCard;
  sessionStatus: CoworkSessionStatus;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** The composer is in its compact size (artifact panel open). */
  compact?: boolean;
  onDismiss?: () => void;
}> = ({ card, sessionStatus, isExpanded, onExpandedChange, compact = false, onDismiss }) => {
  const summary = getProgressCardSummary(card);
  const outcome = getProgressCardOutcome(summary, sessionStatus);
  const [now, setNow] = useState(() => Date.now());
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const currentStepRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!isExpanded) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), UPDATED_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isExpanded]);

  // A long checklist scrolls; keep the step being worked on in view as it advances.
  useEffect(() => {
    const body = bodyRef.current;
    const step = currentStepRef.current;
    if (!isExpanded || !body || !step) return;
    const top = step.offsetTop;
    const bottom = top + step.offsetHeight;
    if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) {
      body.scrollTop = top - (body.clientHeight - step.offsetHeight) / 2;
    }
  }, [isExpanded, summary.position]);

  const steps = card.steps ?? [];
  const isRunning = outcome === ProgressCardOutcome.Running;
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
  const canDismiss = Boolean(onDismiss) && !isRunning;

  const toneClass = OUTCOME_TONE_CLASSES[outcome];
  const leadingIcon = summary.isComplete
    ? <CheckBadge className={`h-4 w-4 ${toneClass}`} />
    : summary.total > 0
      ? <ProgressPie fraction={summary.doneCount / summary.total} className={`h-4 w-4 ${toneClass}`} />
      : isRunning
        ? <Spinner className={`h-4 w-4 ${toneClass}`} />
        : <ClipboardDocumentListIcon className="h-4 w-4 text-secondary" />;

  return (
    <section
      className={`${compact ? 'mx-3' : 'mx-5'} overflow-hidden rounded-t-2xl border border-b-0 border-border bg-surface-raised/60 text-xs text-secondary`}
      aria-label={i18nService.t('progressCardTitle')}
      data-progress-card={outcome}
    >
      <div className="flex min-w-0 items-center gap-1 py-1 pl-2.5 pr-1.5">
        <button
          type="button"
          onClick={() => onExpandedChange(!isExpanded)}
          className="group flex min-h-7 min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={isExpanded}
          aria-controls={bodyId}
        >
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">{leadingIcon}</span>
          <span className="flex-shrink-0 font-semibold text-foreground">{i18nService.t('progressCardTitle')}</span>
          <span className={`min-w-0 flex-1 truncate ${isRunning && !isExpanded ? 'shimmer-text' : ''}`}>
            {isExpanded ? '' : headline}
          </span>
          {meta && <span className="flex-shrink-0 tabular-nums text-muted">{meta}</span>}
          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors group-hover:bg-surface group-hover:text-foreground">
            <ChevronUpIcon
              className={`h-3.5 w-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </span>
        </button>
        {canDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
            title={i18nService.t('progressCardDismiss')}
            aria-label={i18nService.t('progressCardDismiss')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {isExpanded && (
        <div
          ref={bodyRef}
          id={bodyId}
          className="relative max-h-[min(300px,38vh)] animate-fade-in overflow-y-auto overscroll-contain pb-3 pl-2.5 pr-4 [mask-image:linear-gradient(to_bottom,#000_calc(100%_-_12px),transparent)] [overflow-wrap:anywhere]"
          data-progress-card-body
        >
          {card.markdown && (
            <div className={`pl-6 ${steps.length > 0 ? 'mb-2' : ''}`}>
              <ProgressCardMarkdown content={card.markdown} />
            </div>
          )}
          {steps.length > 0 && (
            <ol className="space-y-1">
              {steps.map((step, index) => (
                <li
                  key={`${index}-${step.step}`}
                  ref={index === summary.position - 1 ? currentStepRef : undefined}
                  className="flex items-start gap-2 leading-5"
                  data-status={step.status}
                >
                  <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center" aria-hidden="true">
                    <StepMarker status={step.status} outcome={outcome} />
                  </span>
                  <span className={`min-w-0 transition-colors ${STEP_TEXT_CLASSES[step.status]}`}>{step.step}</span>
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
  const [isExpanded, setIsExpanded] = useState(readProgressCardExpanded);
  const handleExpandedChange = useCallback((expanded: boolean) => {
    setIsExpanded(expanded);
    rememberProgressCardExpanded(expanded);
  }, []);
  if (!card) return null;
  return (
    <div className="relative z-10 -mb-px">
      <OpenClawProgressCardView
        card={card}
        sessionStatus={sessionStatus}
        isExpanded={isExpanded}
        onExpandedChange={handleExpandedChange}
        compact={compact}
        onDismiss={() => void dismiss(card.revision)}
      />
    </div>
  );
};

export default OpenClawProgressCard;
