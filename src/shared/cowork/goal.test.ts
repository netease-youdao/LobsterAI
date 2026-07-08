import { describe, expect, test } from 'vitest';

import {
  CoworkGoalStatus,
  formatCoworkGoalCompletionDuration,
  formatCoworkGoalElapsed,
  formatCoworkGoalUsage,
  normalizeCoworkGoal,
} from './goal';

describe('cowork goal helpers', () => {
  test('normalizes valid OpenClaw goal state', () => {
    expect(normalizeCoworkGoal({
      id: 'goal-1',
      objective: 'Ship goal mode',
      status: 'active',
      createdAt: 1000,
      updatedAt: 2000,
      tokensUsed: 12_300,
      tokenBudget: 50_000,
      tokenStartFresh: true,
    })).toEqual({
      id: 'goal-1',
      objective: 'Ship goal mode',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 2000,
      tokensUsed: 12300,
      tokenBudget: 50000,
      tokenStartFresh: true,
    });
  });

  test('rejects malformed goal state', () => {
    expect(normalizeCoworkGoal({ objective: 'missing id', status: 'active' })).toBeNull();
    expect(normalizeCoworkGoal({ id: 'goal-1', objective: 'bad', status: 'unknown' })).toBeNull();
  });

  test('formats usage and active elapsed time', () => {
    const goal = {
      id: 'goal-1',
      objective: 'Ship',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 1000,
      tokensUsed: 12_300,
      tokenBudget: 50_000,
    };

    expect(formatCoworkGoalUsage(goal)).toBe('12k/50k');
    expect(formatCoworkGoalElapsed(goal, 331_000)).toBe('5m 30s');
    expect(formatCoworkGoalElapsed({ ...goal, status: CoworkGoalStatus.Paused }, 331_000)).toBeNull();
  });

  test('formats completed goal duration', () => {
    const goal = {
      id: 'goal-1',
      objective: 'Ship',
      status: CoworkGoalStatus.Complete,
      createdAt: 1000,
      updatedAt: 383_000,
      completedAt: 383_000,
      tokensUsed: 0,
    };

    expect(formatCoworkGoalCompletionDuration(goal)).toBe('6m 22s');
    expect(formatCoworkGoalCompletionDuration({ ...goal, status: CoworkGoalStatus.Active })).toBeNull();
  });
});
