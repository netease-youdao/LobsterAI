import { afterEach, describe, expect, test, vi } from 'vitest';

import { ScheduledTaskDataStatus } from '../../scheduledTask/constants';
import {
  setAllRunsStatus,
  setTaskListStatus,
  setTasks,
} from '../store/slices/scheduledTaskSlice';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../store', () => ({ store: { dispatch } }));
vi.mock('./i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import { ScheduledTaskService } from './scheduledTask';

function stubScheduledTaskApi(overrides: Record<string, unknown>): void {
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: {
      scheduledTasks: {
        list: vi.fn(async () => ({ success: true, ready: true, tasks: [] })),
        listAllRuns: vi.fn(async () => ({ success: true, ready: true, runs: [] })),
        ...overrides,
      },
    },
  });
}

afterEach(() => {
  dispatch.mockReset();
  vi.unstubAllGlobals();
});

describe('ScheduledTaskService startup state', () => {
  test('keeps the task list in starting state while the gateway is unavailable', async () => {
    stubScheduledTaskApi({
      list: vi.fn(async () => ({ success: true, ready: false, tasks: [] })),
    });
    const service = new ScheduledTaskService();

    await service.loadTasks();

    expect(dispatch.mock.calls.map(call => call[0])).toEqual([
      setTaskListStatus(ScheduledTaskDataStatus.Loading),
      setTaskListStatus(ScheduledTaskDataStatus.Starting),
    ]);
  });

  test('marks an empty task list ready only after a successful gateway query', async () => {
    stubScheduledTaskApi({});
    const service = new ScheduledTaskService();

    await service.loadTasks();

    expect(dispatch.mock.calls.map(call => call[0])).toEqual([
      setTaskListStatus(ScheduledTaskDataStatus.Loading),
      setTasks([]),
    ]);
  });

  test('keeps global history in starting state while the gateway is unavailable', async () => {
    stubScheduledTaskApi({
      listAllRuns: vi.fn(async () => ({ success: true, ready: false, runs: [] })),
    });
    const service = new ScheduledTaskService();

    await service.loadAllRuns(50, 0);

    expect(dispatch.mock.calls.map(call => call[0])).toEqual([
      setAllRunsStatus(ScheduledTaskDataStatus.Loading),
      setAllRunsStatus(ScheduledTaskDataStatus.Starting),
    ]);
  });
});
