import { describe, expect, test } from 'vitest';

import { ScheduledTaskDataStatus } from '../../../scheduledTask/constants';
import scheduledTaskReducer, {
  setAllRuns,
  setAllRunsError,
  setAllRunsStatus,
  setTaskListError,
  setTaskListStatus,
  setTasks,
} from './scheduledTaskSlice';

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
});
