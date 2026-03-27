import { store } from '../store';
import {
  setLoading,
  setError,
  setTasks,
  addTask,
  updateTask,
  removeTask,
  updateTaskState,
  setRuns,
  appendRuns,
  addOrUpdateRun,
  setAllRuns,
  appendAllRuns,
} from '../store/slices/scheduledTaskSlice';
import type {
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskInput,
  ScheduledTaskStatusEvent,
  ScheduledTaskRunEvent,
} from '../../scheduled-task/types';

class ScheduledTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.setupListeners();
    await this.loadTasks();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const cleanupStatus = api.onStatusUpdate(
      (event: ScheduledTaskStatusEvent) => {
        store.dispatch(
          updateTaskState({
            taskId: event.taskId,
            taskState: event.state,
          })
        );
      }
    );
    this.cleanupFns.push(cleanupStatus);

    const cleanupRun = api.onRunUpdate(
      (event: ScheduledTaskRunEvent) => {
        store.dispatch(addOrUpdateRun(event.run));
      }
    );
    this.cleanupFns.push(cleanupRun);

    // Listen for full refresh events (e.g., after first poll or migration)
    const cleanupRefresh = api.onRefresh(() => {
      this.loadTasks();
    });
    this.cleanupFns.push(cleanupRefresh);
  }

  async loadTasks(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    store.dispatch(setLoading(true));
    try {
      const result = await api.list();
      if (result.success && result.tasks) {
        store.dispatch(setTasks(result.tasks));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  async createTask(input: ScheduledTaskInput): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.create(input);
      if (result.success && result.task) {
        store.dispatch(addTask(result.task));
      } else {
        throw new Error(result.error || 'Failed to create task');
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async updateTaskById(
    id: string,
    input: Partial<ScheduledTaskInput>
  ): Promise<void> {
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
      if (result.success) {
        store.dispatch(removeTask(id));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async toggleTask(id: string, enabled: boolean): Promise<string | null> {
    const api = window.electron?.scheduledTasks;
    if (!api) return null;

    try {
      const result = await api.toggle(id, enabled);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      }
      return result.warning ?? null;
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async runManually(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      await api.runManually(id);
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
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

  async loadRuns(taskId: string, limit = 20, offset?: number): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.listRuns(taskId, limit, offset);
      if (result.success && result.runs) {
        const hasMore = result.runs.length >= limit;
        if (offset && offset > 0) {
          store.dispatch(appendRuns({ taskId, runs: result.runs, hasMore }));
        } else {
          store.dispatch(setRuns({ taskId, runs: result.runs, hasMore }));
        }
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadAllRuns(limit?: number, offset?: number): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.listAllRuns(limit, offset);
      if (result.success && result.runs) {
        if (offset && offset > 0) {
          store.dispatch(appendAllRuns(result.runs));
        } else {
          store.dispatch(setAllRuns(result.runs));
        }
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
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

  async listChannelConversations(channel: string): Promise<ScheduledTaskConversationOption[]> {
    const api = window.electron?.scheduledTasks;
    if (!api?.listChannelConversations) return [];

    try {
      const result = await api.listChannelConversations(channel);
      return result.success && result.conversations ? result.conversations : [];
    } catch {
      return [];
    }
  }
}

export const scheduledTaskService = new ScheduledTaskService();
