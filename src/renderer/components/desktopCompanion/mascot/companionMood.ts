import { CoworkSessionStatusValue } from '../../../types/cowork';

/** The companion's current state; drives animations, badges, and labels. */
export const CompanionMood = {
  Idle: 'idle',
  Idea: 'idea',
  Curious: 'curious',
  Catch: 'catch',
  Working: 'working',
  Done: 'done',
  Attention: 'attention',
  Error: 'error',
  Snooze: 'snooze',
} as const;
export type CompanionMood = typeof CompanionMood[keyof typeof CompanionMood];

export interface CompanionMoodInput {
  status: string | null | undefined;
  waiting: boolean;
  unseenResult: boolean;
  snoozed: boolean;
  dropHover: boolean;
  dropStage: boolean;
  hintShowing: boolean;
}

/**
 * Snoozing wins; then a file intentionally brought to the companion;
 * then task news in ChatGPT's order: needs input > failed > ready > running.
 */
export function companionMood(input: CompanionMoodInput): CompanionMood {
  if (input.snoozed) return CompanionMood.Snooze;
  if (input.dropHover) return CompanionMood.Catch;
  if (input.dropStage) return CompanionMood.Curious;
  if (input.waiting) return CompanionMood.Attention;
  if (input.status === CoworkSessionStatusValue.Error) return CompanionMood.Error;
  if (input.unseenResult) return CompanionMood.Done;
  if (input.status === CoworkSessionStatusValue.Running) return CompanionMood.Working;
  if (input.hintShowing) return CompanionMood.Idea;
  return CompanionMood.Idle;
}

/** Tooltip/label key for the current mood. */
export function companionMoodLabelKey(mood: CompanionMood): string {
  switch (mood) {
    case CompanionMood.Working: return 'desktopCompanionOrbRunning';
    case CompanionMood.Done: return 'desktopCompanionOrbDone';
    case CompanionMood.Attention: return 'desktopCompanionOrbWaiting';
    case CompanionMood.Error: return 'desktopCompanionOrbError';
    case CompanionMood.Snooze: return 'desktopCompanionOrbSnoozed';
    default: return 'desktopCompanionOrbIdle';
  }
}
