export const SubagentToolName = {
  Spawn: 'sessions_spawn',
  Yield: 'sessions_yield',
} as const;

export const SubagentYield = {
  ToolName: SubagentToolName.Yield,
  ResultStatus: 'yielded',
  LivenessState: 'paused',
  StopReason: 'end_turn',
  CancelledStatus: 'cancelled',
  TimedOutStatus: 'timed_out',
} as const;
