import { describe, expect, test } from 'vitest';

import {
  type CoworkGoal,
  CoworkGoalStatus,
} from '../../shared/cowork/goal';
import { applyOptimisticGoalCommand } from './goalCommand';

describe('applyOptimisticGoalCommand', () => {
  test('creates an optimistic active goal from start command', () => {
    const goal = applyOptimisticGoalCommand('/goal start Ship the page', null, 'session-1', 1000);
    expect(goal).toMatchObject({
      id: 'optimistic-goal-session-1-1000',
      objective: 'Ship the page',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 1000,
      tokensUsed: 0,
    });
  });

  test('uses only first command line as optimistic objective', () => {
    const goal = applyOptimisticGoalCommand('/goal set Ship the page\n\n文件: /tmp/a.md', null, 'session-1', 1000);
    expect(goal?.objective).toBe('Ship the page');
  });

  test('updates status for pause and resume', () => {
    const currentGoal: CoworkGoal = {
      id: 'goal-1',
      objective: 'Ship',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 1000,
      tokensUsed: 42,
    };
    expect(applyOptimisticGoalCommand('/goal pause', currentGoal, 'session-1', 2000)).toMatchObject({
      status: CoworkGoalStatus.Paused,
      pausedAt: 2000,
      tokensUsed: 42,
    });
    expect(applyOptimisticGoalCommand('/goal resume', currentGoal, 'session-1', 3000)).toMatchObject({
      status: CoworkGoalStatus.Active,
      updatedAt: 3000,
    });
  });

  test('clears goal for clear command', () => {
    expect(applyOptimisticGoalCommand('/goal clear', null, 'session-1', 1000)).toBeNull();
  });

  test('supports done alias and ignores status command', () => {
    const currentGoal: CoworkGoal = {
      id: 'goal-1',
      objective: 'Ship',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 1000,
      tokensUsed: 42,
    };
    expect(applyOptimisticGoalCommand('/goal done', currentGoal, 'session-1', 2000)).toMatchObject({
      status: CoworkGoalStatus.Complete,
      completedAt: 2000,
    });
    expect(applyOptimisticGoalCommand('/goal status', currentGoal, 'session-1', 3000)).toBeUndefined();
  });

  test('ignores non-goal commands', () => {
    expect(applyOptimisticGoalCommand('hello', null, 'session-1', 1000)).toBeUndefined();
  });
});
