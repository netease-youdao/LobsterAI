import { type OpenClawProgressCard, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { type CoworkSessionStatus, CoworkSessionStatusValue } from '../../types/cowork';

/** How the session's run stands relative to a card the agent has not finished. */
export const ProgressCardOutcome = {
  Running: 'running',
  Complete: 'complete',
  TurnEnded: 'turn_ended',
  Stopped: 'stopped',
  Failed: 'failed',
} as const;
export type ProgressCardOutcome = typeof ProgressCardOutcome[keyof typeof ProgressCardOutcome];

export type ProgressCardSummary = {
  total: number;
  doneCount: number;
  /** 1-based position of the step being worked on: the one in progress, else the next pending, else the last. */
  position: number;
  currentStep: string | null;
  isComplete: boolean;
  /** The note as one line of plain text. */
  note: string | null;
};

/** Markdown note → one line of plain text: links keep their text, markup and raw HTML go. */
export const toProgressNoteText = (markdown: string | undefined): string | null => {
  if (!markdown) return null;
  const text = markdown
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
};

export const getProgressCardSummary = (card: OpenClawProgressCard): ProgressCardSummary => {
  const steps = card.steps ?? [];
  const current = steps.find((step) => step.status === ProgressCardStepStatus.InProgress)
    ?? steps.find((step) => step.status === ProgressCardStepStatus.Pending)
    ?? steps[steps.length - 1];
  const doneCount = steps.filter((step) => step.status === ProgressCardStepStatus.Completed).length;
  return {
    total: steps.length,
    doneCount,
    position: current ? steps.indexOf(current) + 1 : 0,
    currentStep: current?.step ?? null,
    isComplete: steps.length > 0 && doneCount === steps.length,
    note: toProgressNoteText(card.markdown),
  };
};

/**
 * A finished checklist reads as complete whatever the session is doing; an
 * unfinished one is running with its session, or says how the run ended.
 */
export const getProgressCardOutcome = (
  summary: ProgressCardSummary,
  sessionStatus: CoworkSessionStatus,
): ProgressCardOutcome => {
  if (summary.isComplete) return ProgressCardOutcome.Complete;
  switch (sessionStatus) {
    case CoworkSessionStatusValue.Running:
      return ProgressCardOutcome.Running;
    case CoworkSessionStatusValue.Error:
      return ProgressCardOutcome.Failed;
    case CoworkSessionStatusValue.Completed:
      return ProgressCardOutcome.TurnEnded;
    default:
      return ProgressCardOutcome.Stopped;
  }
};
