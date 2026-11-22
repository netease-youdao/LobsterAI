import { describe, expect, test } from 'vitest';

import {
  DeliveryMode,
  PayloadKind,
  ScheduledTaskDataStatus,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../../scheduledTask/constants';
import type { ScheduledTask, ScheduledTaskRunWithName, TaskState } from '../../../scheduledTask/types';
import scheduledTaskReducer, {
  addOrUpdateRun,
  appendAllRuns,
  setAllRuns,
  setAllRunsError,
  setAllRunsStatus,
  setTaskListError,
  setTaskListStatus,
  setTasks,
  updateTaskState,
} from './scheduledTaskSlice';

const baseState: TaskState = {
  nextRunAtMs: 1_700_000_000_000,
  lastRunAtMs: null,
  lastStatus: null,
  lastError: null,
  lastDurationMs: null,
  runningAtMs: null,
  consecutiveErrors: 0,
};

function makeTask(id: string, name: string, enabled = true): ScheduledTask {
  return {
    id,
    name,
    description: '',
    enabled,
    schedule: { kind: 'at', at: '2026-11-22T09:00:00.000Z' },
    sessionTarget: SessionTarget.Isolated,
    wakeMode: WakeMode.Now,
    payload: { kind: PayloadKind.AgentTurn, message: 'ping' },
    delivery: { mode: DeliveryMode.None },
    agentId: 'main',
    sessionKey: null,
    state: { ...baseState },
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
  };
}

describe('scheduledTaskSlice data status', () => {
  test('distinguishes service startup from a loaded empty task list', () => {
    const initial = scheduledTaskReducer(undefined, { type: 'init' });
    expect(initial.taskListStatus).toBe(ScheduledTaskDataStatus.Starting);

    const loading = scheduledTaskReducer(
      initial,
      setTaskListStatus(ScheduledTaskDataStatus.Loading),
    );
    expect(loading.taskListStatus).toBe(ScheduledTaskDataStatus.Loading);

    const ready = scheduledTaskReducer(loading, setTasks([]));
    expect(ready.taskListStatus).toBe(ScheduledTaskDataStatus.Ready);
    expect(ready.tasks).toEqual([]);
  });

  test('tracks task and history failures independently', () => {
    const taskError = scheduledTaskReducer(undefined, setTaskListError('task failure'));
    expect(taskError.taskListStatus).toBe(ScheduledTaskDataStatus.Error);
    expect(taskError.taskListError).toBe('task failure');
    expect(taskError.allRunsStatus).toBe(ScheduledTaskDataStatus.Starting);

    const historyLoading = scheduledTaskReducer(
      taskError,
      setAllRunsStatus(ScheduledTaskDataStatus.Loading),
    );
    const historyError = scheduledTaskReducer(
      historyLoading,
      setAllRunsError('history failure'),
    );
    expect(historyError.allRunsStatus).toBe(ScheduledTaskDataStatus.Error);
    expect(historyError.allRunsError).toBe('history failure');

    const historyReady = scheduledTaskReducer(
      historyError,
      setAllRuns({ runs: [], hasMore: false }),
    );
    expect(historyReady.allRunsStatus).toBe(ScheduledTaskDataStatus.Ready);
    expect(historyReady.allRunsError).toBeNull();
  });

  test('updateTaskState applies enabled flag when a one-shot task auto-disables', () => {
    const seeded = scheduledTaskReducer(undefined, setTasks([makeTask('t-1', 'One-shot', true)]));

    // Without enabled, keeps existing enabled value.
    const running = scheduledTaskReducer(
      seeded,
      updateTaskState({
        taskId: 't-1',
        taskState: { ...baseState, runningAtMs: 1_700_000_000_000, lastStatus: TaskStatus.Running },
      }),
    );
    expect(running.tasks[0].enabled).toBe(true);
    expect(running.tasks[0].state.lastStatus).toBe(TaskStatus.Running);

    // With enabled: false, immediately flips UI toggle OFF.
    const disabled = scheduledTaskReducer(
      running,
      updateTaskState({
        taskId: 't-1',
        taskState: { ...baseState, nextRunAtMs: null, lastStatus: TaskStatus.Success, runningAtMs: null },
        enabled: false,
      }),
    );
    expect(disabled.tasks[0].enabled).toBe(false);
    expect(disabled.tasks[0].state.nextRunAtMs).toBeNull();
  });

  test('addOrUpdateRun keeps both runs[taskId] and allRuns synchronized and appendAllRuns deduplicates', () => {
    const seeded = scheduledTaskReducer(
      scheduledTaskReducer(undefined, setTasks([makeTask('t-1', 'Morning Digest', true)])),
      setAllRuns({ runs: [], hasMore: false }),
    );

    const runningEntry: ScheduledTaskRunWithName = {
      id: 'run-1',
      taskId: 't-1',
      taskName: 'Morning Digest',
      sessionId: null,
      sessionKey: null,
      status: TaskStatus.Running,
      startedAt: '2026-11-22T08:00:00.000Z',
      finishedAt: null,
      durationMs: null,
      error: null,
    };

    const afterStart = scheduledTaskReducer(seeded, addOrUpdateRun(runningEntry));
    expect(afterStart.runs['t-1']).toHaveLength(1);
    expect(afterStart.runs['t-1'][0].status).toBe(TaskStatus.Running);
    expect(afterStart.allRuns).toHaveLength(1);
    expect(afterStart.allRuns[0]).toMatchObject({
      id: 'run-1',
      taskName: 'Morning Digest',
      status: TaskStatus.Running,
    });

    // Updating the same run replaces in place in both runs[taskId] and allRuns.
    const finishedEntry: ScheduledTaskRunWithName = {
      ...runningEntry,
      sessionId: 'cw-1',
      status: TaskStatus.Success,
      finishedAt: '2026-11-22T08:00:03.000Z',
      durationMs: 3000,
      summary: 'Done',
    };
    const afterFinish = scheduledTaskReducer(afterStart, addOrUpdateRun(finishedEntry));
    expect(afterFinish.runs['t-1']).toHaveLength(1);
    expect(afterFinish.runs['t-1'][0].status).toBe(TaskStatus.Success);
    expect(afterFinish.allRuns).toHaveLength(1);
    expect(afterFinish.allRuns[0]).toMatchObject({
      id: 'run-1',
      status: TaskStatus.Success,
      summary: 'Done',
    });

    // Paginating older runs does not duplicate live runs already in allRuns.
    const olderRun: ScheduledTaskRunWithName = {
      ...finishedEntry,
      id: 'run-0',
      startedAt: '2026-11-21T08:00:00.000Z',
    };
    const afterAppend = scheduledTaskReducer(
      afterFinish,
      appendAllRuns({ runs: [finishedEntry, olderRun], hasMore: false }),
    );
    expect(afterAppend.allRuns.map(r => r.id)).toEqual(['run-1', 'run-0']);
  });
});
