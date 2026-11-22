import {
  type CoworkGoal,
  CoworkGoalStatus,
} from '../../shared/cowork/goal';

type OptimisticGoalAction =
  | 'start'
  | 'set'
  | 'edit'
  | 'create'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'done'
  | 'block'
  | 'blocked'
  | 'clear'
  | 'status';

const KNOWN_GOAL_ACTIONS = new Set<string>([
  'start',
  'set',
  'edit',
  'create',
  'pause',
  'resume',
  'complete',
  'done',
  'block',
  'blocked',
  'clear',
  'status',
]);

const GOAL_PREFIX_RE = /^\/goal(?=$|\s)([\s\S]*)$/i;

const parseOptimisticGoalCommand = (
  command: string,
): { action: OptimisticGoalAction; text: string } | null => {
  const match = GOAL_PREFIX_RE.exec(command.trim());
  if (!match) return null;
  const rest = (match[1] ?? '').trim();
  if (!rest) return null;
  const tokenMatch = /^([a-z]+)(?:\s+([\s\S]*))?$/i.exec(rest);
  const firstToken = tokenMatch?.[1]?.toLowerCase();
  if (firstToken && KNOWN_GOAL_ACTIONS.has(firstToken)) {
    return {
      action: firstToken as OptimisticGoalAction,
      text: tokenMatch?.[2] ?? '',
    };
  }
  return {
    action: 'start',
    text: rest,
  };
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
  const parsed = parseOptimisticGoalCommand(command);
  if (!parsed) return undefined;

  const { action, text } = parsed;

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
  if (action === 'edit' && currentGoal && currentGoal.status !== CoworkGoalStatus.Complete) {
    return {
      ...currentGoal,
      objective,
      updatedAt: now,
    };
  }
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
