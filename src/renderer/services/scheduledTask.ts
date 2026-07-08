import { ScheduledTaskDataStatus } from '../../scheduledTask/constants';
import type {
  RunFilter,
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskInput,
  ScheduledTaskRunEvent,
  ScheduledTaskStatusEvent,
} from '../../scheduledTask/types';
import { store } from '../store';
import {
  addOrUpdateRun,
  addTask,
  appendAllRuns,
  appendRuns,
  markTaskRunning,
  removeTask,
  setAllRuns,
  setAllRunsError,
  setAllRunsStatus,
  setError,
  setRuns,
  setTaskListError,
  setTaskListStatus,
  setTasks,
  updateTask,
  updateTaskState,
} from '../store/slices/scheduledTaskSlice';
import { i18nService } from './i18n';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

function hasTaskDataAnomaly(task: ScheduledTask): boolean {
  if (task.schedule.kind === 'every') {
    const ms = task.schedule.everyMs;
    if (!Number.isFinite(ms) || ms <= 0) return true;
  }
  if (task.schedule.kind === 'at') {
    const d = new Date(task.schedule.at);
    if (!Number.isFinite(d.getTime())) return true;
  }
  const ts = task.state;
  const nums = [ts.nextRunAtMs, ts.lastRunAtMs, ts.lastDurationMs, ts.runningAtMs];
  for (const v of nums) {
    if (v !== null && !Number.isFinite(v)) return true;
  }
  return false;
}

function checkTasksForAnomalies(tasks: ScheduledTask[]): void {
  const anomalous = tasks.filter(hasTaskDataAnomaly);
  if (anomalous.length === 0) return;

  const name = anomalous[0].name;
  const msg = i18nService.t('scheduledTasksDataAnomalyWarning').replace('{name}', name);
  showToast(msg);
}

export class ScheduledTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  private taskListRequestId = 0;
  private allRunsRequestId = 0;
  private runRequestIds = new Map<string, number>();
  private lastAllRunsRequest: { limit?: number; filter?: RunFilter } | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.setupListeners();
    await this.loadTasks();
  }

  destroy(): void {
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const cleanupStatus = api.onStatusUpdate((event: ScheduledTaskStatusEvent) => {
      store.dispatch(
        updateTaskState({
          taskId: event.taskId,
          taskState: event.state,
        }),
      );
    });
    this.cleanupFns.push(cleanupStatus);

    const cleanupRun = api.onRunUpdate((event: ScheduledTaskRunEvent) => {
      store.dispatch(addOrUpdateRun(event.run));
    });
    this.cleanupFns.push(cleanupRun);

    // Listen for full refresh events (e.g., after first poll or migration)
    const cleanupRefresh = api.onRefresh(() => {
      void this.loadTasks();
      if (this.lastAllRunsRequest) {
        void this.loadAllRuns(
          this.lastAllRunsRequest.limit,
          0,
          this.lastAllRunsRequest.filter,
        );
      }
    });
    this.cleanupFns.push(cleanupRefresh);
  }

  async loadTasks(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const requestId = this.taskListRequestId + 1;
    this.taskListRequestId = requestId;
    store.dispatch(setTaskListStatus(ScheduledTaskDataStatus.Loading));
    try {
      const result = await api.list();
      if (this.taskListRequestId !== requestId) return;
      if (result.ready === false) {
        store.dispatch(setTaskListStatus(ScheduledTaskDataStatus.Starting));
        return;
      }
      if (result.success && result.tasks) {
        checkTasksForAnomalies(result.tasks);
        store.dispatch(setTasks(result.tasks));
      } else {
        const message = result.error || 'Failed to load scheduled tasks';
        store.dispatch(setTaskListError(message));
      }
    } catch (err: unknown) {
      if (this.taskListRequestId !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      store.dispatch(setTaskListError(message));
      store.dispatch(setError(message));
    }
  }

  async createTask(input: ScheduledTaskInput): Promise<string | null> {
    const api = window.electron?.scheduledTasks;
    if (!api) return null;

    try {
      const result = await api.create(input);
      if (result.success && result.task) {
        if (hasTaskDataAnomaly(result.task)) {
          const msg = i18nService
            .t('scheduledTasksDataAnomalyWarning')
            .replace('{name}', result.task.name);
          showToast(msg);
        }
        store.dispatch(addTask(result.task));
        return result.task.id;
      } else {
        throw new Error(result.error || 'Failed to create task');
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async updateTaskById(id: string, input: Partial<ScheduledTaskInput>): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.update(id, input);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      } else if (!result.success) {
        const errorMsg = result.error || 'Failed to update task';
        store.dispatch(setError(errorMsg));
        throw new Error(errorMsg);
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async deleteTask(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.delete(id);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to delete task');
      }
      store.dispatch(removeTask(id));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`${i18nService.t('scheduledTasksDeleteFailed')}: ${message}`);
      store.dispatch(setError(message));
      throw err;
    }
  }

  async toggleTask(id: string, enabled: boolean): Promise<string | null> {
    const api = window.electron?.scheduledTasks;
    if (!api) return null;

    const previous = store.getState().scheduledTask.tasks.find(t => t.id === id);
    // Optimistic: flip the switch immediately so it reacts to the tap, then
    // reconcile with the authoritative task (or roll back) once the call lands.
    if (previous) {
      store.dispatch(updateTask({ ...previous, enabled }));
    }
    try {
      const result = await api.toggle(id, enabled);
      if (!result.success) {
        throw new Error(result.error || 'Failed to toggle task');
      }
      if (result.task) {
        store.dispatch(updateTask(result.task));
      }
      return result.warning ?? null;
    } catch (err: unknown) {
      if (previous) {
        store.dispatch(updateTask(previous));
      }
      const message = err instanceof Error ? err.message : String(err);
      showToast(`${i18nService.t('scheduledTasksToggleFailed')}: ${message}`);
      store.dispatch(setError(message));
      throw err;
    }
  }

  async runManually(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const task = store.getState().scheduledTask.tasks.find(t => t.id === id);
    // Optimistic: flip the task to "running" right away so the button/status
    // react instantly instead of waiting for the next gateway status poll.
    store.dispatch(markTaskRunning(id));
    try {
      const result = await api.runManually(id);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to run task');
      }
      const name = task?.name?.trim();
      showToast(
        name
          ? i18nService.t('scheduledTasksRunStartedToast').replace('{name}', name)
          : i18nService.t('scheduledTasksRunStartedToastGeneric'),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`${i18nService.t('scheduledTasksRunFailed')}: ${message}`);
      store.dispatch(setError(message));
      // Roll back the optimistic running state.
      void this.loadTasks();
      throw err;
    }
  }

  async stopTask(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      await api.stop(id);
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async loadRuns(taskId: string, limit = 20, offset?: number, filter?: RunFilter): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const requestId = (this.runRequestIds.get(taskId) ?? 0) + 1;
    this.runRequestIds.set(taskId, requestId);
    try {
      const result = await api.listRuns(taskId, limit, offset, filter);
      if (this.runRequestIds.get(taskId) !== requestId) return;
      if (result.success && result.runs) {
        const hasMore = result.runs.length >= limit;
        if (offset && offset > 0) {
          store.dispatch(appendRuns({ taskId, runs: result.runs, hasMore }));
        } else {
          store.dispatch(setRuns({ taskId, runs: result.runs, hasMore }));
        }
      }
    } catch (err: unknown) {
      if (this.runRequestIds.get(taskId) !== requestId) return;
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadAllRuns(limit?: number, offset?: number, filter?: RunFilter): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const isInitialRequest = !offset || offset <= 0;
    if (isInitialRequest) {
      this.lastAllRunsRequest = { limit, filter };
      store.dispatch(setAllRunsStatus(ScheduledTaskDataStatus.Loading));
    }
    const requestId = this.allRunsRequestId + 1;
    this.allRunsRequestId = requestId;
    try {
      const result = await api.listAllRuns(limit, offset, filter);
      if (this.allRunsRequestId !== requestId) return;
      if (result.ready === false) {
        store.dispatch(setAllRunsStatus(ScheduledTaskDataStatus.Starting));
        return;
      }
      if (result.success && result.runs) {
        const hasMore = (result.runs as unknown[]).length >= (limit ?? 50);
        if (offset && offset > 0) {
          store.dispatch(appendAllRuns({ runs: result.runs, hasMore }));
        } else {
          store.dispatch(setAllRuns({ runs: result.runs, hasMore }));
        }
      } else if (isInitialRequest) {
        store.dispatch(setAllRunsError(result.error || 'Failed to load scheduled task history'));
      }
    } catch (err: unknown) {
      if (this.allRunsRequestId !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      if (isInitialRequest) {
        store.dispatch(setAllRunsError(message));
      }
      store.dispatch(setError(message));
    }
  }

  async listChannels(): Promise<ScheduledTaskChannelOption[]> {
    const api = window.electron?.scheduledTasks;
    if (!api?.listChannels) return [];

    try {
      const result = await api.listChannels();
      return result.success && result.channels ? result.channels : [];
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      return [];
    }
  }

  async listChannelConversations(
    channel: string,
    accountId?: string,
    filterAccountId?: string,
  ): Promise<ScheduledTaskConversationOption[]> {
    const api = window.electron?.scheduledTasks;
    if (!api?.listChannelConversations) return [];

    try {
      const result = await api.listChannelConversations(channel, accountId, filterAccountId);
      return result.success && result.conversations ? result.conversations : [];
    } catch {
      return [];
    }
  }
}

export const scheduledTaskService = new ScheduledTaskService();
