export const CoworkGoalStatus = {
  Active: 'active',
  Paused: 'paused',
  Blocked: 'blocked',
  UsageLimited: 'usage_limited',
  BudgetLimited: 'budget_limited',
  Complete: 'complete',
} as const;

export type CoworkGoalStatus = typeof CoworkGoalStatus[keyof typeof CoworkGoalStatus];

export interface CoworkGoal {
  id: string;
  objective: string;
  status: CoworkGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart?: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  continuationTurns?: number;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
}

export function isCoworkGoalStatus(value: unknown): value is CoworkGoalStatus {
  return typeof value === 'string'
    && Object.values(CoworkGoalStatus).includes(value as CoworkGoalStatus);
}

const readFiniteNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const readOptionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

export function normalizeCoworkGoal(value: unknown): CoworkGoal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readOptionalString(record, 'id');
  const objective = readOptionalString(record, 'objective');
  const status = record.status;
  const createdAt = readFiniteNumber(record, 'createdAt');
  const updatedAt = readFiniteNumber(record, 'updatedAt');

  if (!id || !objective || !isCoworkGoalStatus(status) || createdAt === undefined || updatedAt === undefined) {
    return null;
  }

  return {
    id,
    objective,
    status,
    createdAt,
    updatedAt,
    ...(readFiniteNumber(record, 'tokenStart') !== undefined ? { tokenStart: readFiniteNumber(record, 'tokenStart') } : {}),
    ...(typeof record.tokenStartFresh === 'boolean' ? { tokenStartFresh: record.tokenStartFresh } : {}),
    tokensUsed: Math.max(0, Math.floor(readFiniteNumber(record, 'tokensUsed') ?? 0)),
    ...(readFiniteNumber(record, 'tokenBudget') !== undefined ? { tokenBudget: Math.max(0, Math.floor(readFiniteNumber(record, 'tokenBudget') ?? 0)) } : {}),
    ...(readFiniteNumber(record, 'continuationTurns') !== undefined ? { continuationTurns: Math.max(0, Math.floor(readFiniteNumber(record, 'continuationTurns') ?? 0)) } : {}),
    ...(readOptionalString(record, 'lastStatusNote') ? { lastStatusNote: readOptionalString(record, 'lastStatusNote') } : {}),
    ...(readFiniteNumber(record, 'pausedAt') !== undefined ? { pausedAt: readFiniteNumber(record, 'pausedAt') } : {}),
    ...(readFiniteNumber(record, 'blockedAt') !== undefined ? { blockedAt: readFiniteNumber(record, 'blockedAt') } : {}),
    ...(readFiniteNumber(record, 'completedAt') !== undefined ? { completedAt: readFiniteNumber(record, 'completedAt') } : {}),
    ...(readFiniteNumber(record, 'usageLimitedAt') !== undefined ? { usageLimitedAt: readFiniteNumber(record, 'usageLimitedAt') } : {}),
    ...(readFiniteNumber(record, 'budgetLimitedAt') !== undefined ? { budgetLimitedAt: readFiniteNumber(record, 'budgetLimitedAt') } : {}),
  };
}

export function formatCoworkGoalTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const rounded = value >= 10_000 ? Math.round(value / 1000) : Math.round(value / 100) / 10;
    return `${rounded}k`;
  }
  const rounded = value >= 10_000_000
    ? Math.round(value / 1_000_000)
    : Math.round(value / 100_000) / 10;
  return `${rounded}m`;
}

export function formatCoworkGoalUsage(goal: CoworkGoal): string | null {
  if (goal.tokenBudget !== undefined && goal.tokenBudget > 0) {
    return `${formatCoworkGoalTokenCount(goal.tokensUsed)}/${formatCoworkGoalTokenCount(goal.tokenBudget)}`;
  }
  return goal.tokensUsed > 0 ? `${formatCoworkGoalTokenCount(goal.tokensUsed)} used` : null;
}

function formatCoworkGoalDurationMs(elapsedMs: number): string | null {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 1) return null;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatCoworkGoalElapsed(goal: CoworkGoal, now = Date.now()): string | null {
  if (goal.status !== CoworkGoalStatus.Active) return null;
  return formatCoworkGoalDurationMs(Math.max(0, now - goal.createdAt));
}

export function formatCoworkGoalCompletionDuration(goal: CoworkGoal): string | null {
  if (goal.status !== CoworkGoalStatus.Complete) return null;
  const completedAt = goal.completedAt ?? goal.updatedAt;
  return formatCoworkGoalDurationMs(Math.max(0, completedAt - goal.createdAt));
}
