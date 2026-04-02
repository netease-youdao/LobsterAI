import { CronJobService } from '../../../scheduledTask/cronJobService';

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

export interface CronJobServiceDeps {
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => GatewayClientLike | null;
    ensureReady: () => Promise<void>;
  } | null;
}

let cronJobService: CronJobService | null = null;
let deps: CronJobServiceDeps | null = null;

export function initCronJobServiceManager(d: CronJobServiceDeps): void {
  deps = d;
}

export function getCronJobService(): CronJobService {
  if (!cronJobService) {
    if (!deps) {
      throw new Error('CronJobServiceManager not initialized. Call initCronJobServiceManager() first.');
    }
    const adapter = deps.getOpenClawRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenClaw runtime adapter not initialized. CronJobService requires OpenClaw.');
    }
    cronJobService = new CronJobService({
      getGatewayClient: () => adapter.getGatewayClient(),
      ensureGatewayReady: () => adapter.ensureReady(),
    });
  }
  return cronJobService;
}
