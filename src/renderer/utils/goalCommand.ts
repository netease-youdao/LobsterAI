import {
  type CoworkGoal,
  CoworkGoalStatus,
} from '../../shared/cowork/goal';

type OptimisticGoalAction =
  | 'start'
  | 'set'
  | 'create'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'done'
  | 'block'
  | 'blocked'
  | 'clear'
  | 'status';

const GOAL_COMMAND_RE = /^\/goal(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/i;

const normalizeGoalAction = (action: string | undefined, text: string): OptimisticGoalAction | null => {
  const normalized = action?.toLowerCase();
  if (!normalized) return text.trim() ? 'start' : null;
  if (
    normalized === 'start'
    || normalized === 'set'
    || normalized === 'create'
    || normalized === 'pause'
    || normalized === 'resume'
    || normalized === 'complete'
    || normalized === 'done'
    || normalized === 'block'
    || normalized === 'blocked'
    || normalized === 'clear'
    || normalized === 'status'
  ) {
    return normalized;
  }
  return text.trim() ? 'start' : null;
};

const readGoalObjective = (text: string): string => {
  return text.replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? '';
};

export function applyOptimisticGoalCommand(
  command: string,
  currentGoal: CoworkGoal | null | undefined,
  sessionId: string,
  now = Date.now(),
): CoworkGoal | null | undefined {
  const match = GOAL_COMMAND_RE.exec(command.trim());
  if (!match) return undefined;

  const text = match[2] ?? '';
  const action = normalizeGoalAction(match[1], text);
  if (!action) return undefined;

  if (action === 'status') {
    return undefined;
  }

  if (action === 'clear') {
    return null;
  }

  if (action === 'pause' || action === 'resume' || action === 'complete' || action === 'done' || action === 'block' || action === 'blocked') {
    if (!currentGoal) return undefined;
    const status = action === 'pause'
      ? CoworkGoalStatus.Paused
      : action === 'resume'
        ? CoworkGoalStatus.Active
        : action === 'complete' || action === 'done'
          ? CoworkGoalStatus.Complete
          : CoworkGoalStatus.Blocked;
    return {
      ...currentGoal,
      status,
      updatedAt: now,
      ...(status === CoworkGoalStatus.Paused ? { pausedAt: now } : {}),
      ...(status === CoworkGoalStatus.Blocked ? { blockedAt: now } : {}),
      ...(status === CoworkGoalStatus.Complete ? { completedAt: now } : {}),
    };
  }

  const objective = readGoalObjective(text);
  if (!objective) return undefined;
  return {
    id: currentGoal?.id ?? `optimistic-goal-${sessionId}-${now}`,
    objective,
    status: CoworkGoalStatus.Active,
    createdAt: currentGoal?.createdAt ?? now,
    updatedAt: now,
    tokensUsed: currentGoal?.tokensUsed ?? 0,
    ...(currentGoal?.tokenBudget !== undefined ? { tokenBudget: currentGoal.tokenBudget } : {}),
  };
}
