import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DeliveryMode,
  PayloadKind,
  ScheduleKind,
  ScheduledTaskErrorCode,
  SessionTarget,
  WakeMode,
} from '../../scheduledTask/constants';
import type { ScheduledTaskInput } from '../../scheduledTask/types';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock('../store', () => ({
  store: {
    dispatch: dispatchMock,
  },
}));

const baseInput: ScheduledTaskInput = {
  name: 'Daily Report',
  description: '',
  enabled: true,
  schedule: {
    kind: ScheduleKind.Cron,
    expr: '0 9 * * *',
  },
  sessionTarget: SessionTarget.Isolated,
  wakeMode: WakeMode.Now,
  payload: {
    kind: PayloadKind.AgentTurn,
    message: 'Summarize the daily metrics',
  },
  delivery: {
    mode: DeliveryMode.None,
  },
};

describe('scheduledTaskService', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    vi.resetModules();
  });

  test('preserves duplicate-name error codes when create fails', async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: false,
      error: 'Scheduled task name already exists',
      errorCode: ScheduledTaskErrorCode.DuplicateName,
    });

    (globalThis as any).window = {
      electron: {
        scheduledTasks: {
          create: createMock,
        },
      },
    };

    const { scheduledTaskService } = await import('./scheduledTask');

    await expect(scheduledTaskService.createTask(baseInput)).rejects.toMatchObject({
      message: 'Scheduled task name already exists',
      errorCode: ScheduledTaskErrorCode.DuplicateName,
    });
  });

  test('preserves duplicate-name error codes when update fails', async () => {
    const updateMock = vi.fn().mockResolvedValue({
      success: false,
      error: 'Scheduled task name already exists',
      errorCode: ScheduledTaskErrorCode.DuplicateName,
    });

    (globalThis as any).window = {
      electron: {
        scheduledTasks: {
          update: updateMock,
        },
      },
    };

    const { scheduledTaskService } = await import('./scheduledTask');

    await expect(scheduledTaskService.updateTaskById('task-1', {
      name: 'Daily Report',
    })).rejects.toMatchObject({
      message: 'Scheduled task name already exists',
      errorCode: ScheduledTaskErrorCode.DuplicateName,
    });
  });
});
