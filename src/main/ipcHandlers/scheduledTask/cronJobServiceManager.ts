// Facade backing the `scheduledTask:*` IPC handlers onto the engine-independent
// SQLite `LobsterScheduler` instead of OpenClaw's internal cron gateway.

import type {
  RunFilter,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
} from '../../../scheduledTask/types';
import type { LobsterScheduler } from '../../scheduledTask/lobsterScheduler';

export interface CronJobServiceFacade {
  listJobs(): Promise<ScheduledTask[]>;
  getJob(id: string): Promise<ScheduledTask | null>;
  addJob(input: ScheduledTaskInput): Promise<ScheduledTask>;
  updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask>;
  removeJob(id: string): Promise<void>;
  toggleJob(id: string, enabled: boolean): Promise<ScheduledTask>;
  runJob(id: string): Promise<void>;
  stopJob(id: string): Promise<boolean>;
  listRuns(taskId: string, limit?: number, offset?: number, filter?: RunFilter): Promise<ScheduledTaskRun[]>;
  countRuns(taskId: string): Promise<number>;
  listAllRuns(limit?: number, offset?: number, filter?: RunFilter): Promise<ScheduledTaskRunWithName[]>;
  getJobNameSync(id: string): string | null;
  getJobDeliverySync(id: string): ScheduledTaskDelivery | null;
  startPolling(): void;
  stopPolling(): void;
  notifyGatewayReady(): void;
}

export interface CronJobServiceDeps {
  getScheduler: () => LobsterScheduler | null;
}

let cronJobService: CronJobServiceFacade | null = null;
let deps: CronJobServiceDeps | null = null;

export function initCronJobServiceManager(d: CronJobServiceDeps): void {
  deps = d;
  cronJobService = null;
}

export function peekCronJobService(): CronJobServiceFacade | null {
  return cronJobService;
}

export function getCronJobService(): CronJobServiceFacade {
  if (!cronJobService) {
    if (!deps) {
      throw new Error('CronJobServiceManager not initialized. Call initCronJobServiceManager() first.');
    }
    const requireScheduler = (): LobsterScheduler => {
      const scheduler = deps?.getScheduler();
      if (!scheduler) {
        throw new Error('LobsterScheduler not initialized.');
      }
      return scheduler;
    };

    cronJobService = {
      listJobs: async () => requireScheduler().listTasks(),
      getJob: async (id) => requireScheduler().getTask(id),
      addJob: async (input) => requireScheduler().createTask(input),
      updateJob: async (id, input) => requireScheduler().updateTask(id, input),
      removeJob: async (id) => {
        requireScheduler().deleteTask(id);
      },
      toggleJob: async (id, enabled) => requireScheduler().toggleTask(id, enabled),
      runJob: async (id) => {
        const { completion } = requireScheduler().startRunNow(id);
        completion.catch((error) => {
          console.error(`[ScheduledTask] Background manual run failed for ${id}:`, error);
        });
      },
      stopJob: async (id) => requireScheduler().stopTask(id),
      listRuns: async (taskId, limit, offset, filter) =>
        requireScheduler().listRuns(taskId, limit, offset, filter),
      countRuns: async (taskId) => requireScheduler().countRuns(taskId),
      listAllRuns: async (limit, offset, filter) =>
        requireScheduler().listAllRuns(limit, offset, filter),
      getJobNameSync: (id) => deps?.getScheduler()?.getTask(id)?.name ?? null,
      getJobDeliverySync: (id) => deps?.getScheduler()?.getTask(id)?.delivery ?? null,
      startPolling: () => {
        deps?.getScheduler()?.start();
      },
      stopPolling: () => {
        deps?.getScheduler()?.stop();
      },
      notifyGatewayReady: () => {
        deps?.getScheduler()?.start();
      },
    };
  }
  return cronJobService;
}
