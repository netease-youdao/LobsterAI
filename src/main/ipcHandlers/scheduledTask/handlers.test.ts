import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  IpcChannel as ScheduledTaskIpc,
  ScheduledTaskErrorCode,
} from '../../../scheduledTask/constants';

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

import { registerScheduledTaskHandlers, type ScheduledTaskHandlerDeps } from './handlers';

function getHandler(channel: string) {
  const entry = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!entry) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return entry[1] as (...args: any[]) => Promise<any>;
}

describe('registerScheduledTaskHandlers duplicate name guard', () => {
  const cronJobService = {
    listJobs: vi.fn(),
    addJob: vi.fn(),
    updateJob: vi.fn(),
    getJob: vi.fn(),
    removeJob: vi.fn(),
    toggleJob: vi.fn(),
    runJob: vi.fn(),
    listRuns: vi.fn(),
    countRuns: vi.fn(),
    listAllRuns: vi.fn(),
  };

  const deps: ScheduledTaskHandlerDeps = {
    getCronJobService: () => cronJobService as any,
    getIMGatewayManager: () => null,
    getOpenClawRuntimeAdapter: () => null,
  };

  beforeEach(() => {
    handleMock.mockClear();
    Object.values(cronJobService).forEach((mockFn) => {
      if (typeof mockFn === 'function' && 'mockReset' in mockFn) {
        mockFn.mockReset();
      }
    });
    registerScheduledTaskHandlers(deps);
  });

  test('rejects create when another task already has the same trimmed name', async () => {
    cronJobService.listJobs.mockResolvedValue([
      { id: 'task-1', name: 'Daily Report' },
    ]);

    const createHandler = getHandler(ScheduledTaskIpc.Create);
    const result = await createHandler({}, {
      name: '  Daily Report  ',
      delivery: { mode: 'none' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(result.errorCode).toBe(ScheduledTaskErrorCode.DuplicateName);
    expect(cronJobService.addJob).not.toHaveBeenCalled();
  });

  test('rejects update when another task already has the same trimmed name', async () => {
    cronJobService.listJobs.mockResolvedValue([
      { id: 'task-1', name: 'Daily Report' },
      { id: 'task-2', name: 'Weekly Digest' },
    ]);

    const updateHandler = getHandler(ScheduledTaskIpc.Update);
    const result = await updateHandler({}, 'task-2', {
      name: ' Daily Report ',
      delivery: { mode: 'none' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(result.errorCode).toBe(ScheduledTaskErrorCode.DuplicateName);
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
  });

  test('allows update when the name only matches the current task', async () => {
    cronJobService.listJobs.mockResolvedValue([
      { id: 'task-1', name: 'Daily Report' },
    ]);
    cronJobService.updateJob.mockResolvedValue({
      id: 'task-1',
      name: 'Daily Report',
    });

    const updateHandler = getHandler(ScheduledTaskIpc.Update);
    const result = await updateHandler({}, 'task-1', {
      name: ' Daily Report ',
      delivery: { mode: 'none' },
    });

    expect(result.success).toBe(true);
    expect(cronJobService.updateJob).toHaveBeenCalledWith('task-1', {
      name: ' Daily Report ',
      delivery: { mode: 'none' },
    });
  });
});
