export const SubagentToolName = {
  Spawn: 'sessions_spawn',
  Yield: 'sessions_yield',
  DshSpawn: 'subagent',
  DshFork: 'subagent_fork',
  DshWait: 'wait_agent',
} as const;

export function isDshSubagentSpawn(name: unknown): boolean {
  return name === SubagentToolName.DshSpawn || name === SubagentToolName.DshFork;
}

export const SubagentYield = {
  ToolName: SubagentToolName.Yield,
  ResultStatus: 'yielded',
  LivenessState: 'paused',
  StopReason: 'end_turn',
  CancelledStatus: 'cancelled',
  TimedOutStatus: 'timed_out',
} as const;
