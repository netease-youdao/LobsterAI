export const CoworkTurnOutcome = {
  Completed: 'completed',
  Stopped: 'stopped',
  Failed: 'failed',
} as const;
export type CoworkTurnOutcome = typeof CoworkTurnOutcome[keyof typeof CoworkTurnOutcome];

export function getCoworkTurnOutcome(metadata?: Record<string, unknown>): CoworkTurnOutcome | undefined {
  return Object.values(CoworkTurnOutcome).find(outcome => outcome === metadata?.turnOutcome);
}
