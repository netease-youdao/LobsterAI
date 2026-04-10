import { app, BrowserWindow, nativeImage, Notification } from 'electron';
import fs from 'fs';
import path from 'path';

import { StoreKey, TaskStatus } from '../../../scheduledTask/constants';
import { CronJobService } from '../../../scheduledTask/cronJobService';
import type { ScheduledTaskRunWithName } from '../../../scheduledTask/types';
import { t } from '../../i18n';

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

type StoreLike = {
  get: <T = unknown>(key: string) => T | undefined;
};

export interface CronJobServiceDeps {
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => GatewayClientLike | null;
    ensureReady: () => Promise<void>;
  } | null;
  getStore: () => StoreLike;
}

let cronJobService: CronJobService | null = null;
let deps: CronJobServiceDeps | null = null;

/** Resolve an icon path suitable for Electron Notification. */
function getNotificationIconPath(): string | undefined {
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', '..', '..', 'resources', 'tray');
  const iconPath =
    process.platform === 'win32'
      ? path.join(basePath, 'tray-icon.ico')
      : path.join(basePath, 'tray-icon.png');
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

/** Show an OS notification for a completed scheduled task run. */
function showRunNotification(run: ScheduledTaskRunWithName): void {
  if (!Notification.isSupported()) return;

  const store = deps?.getStore();
  if (!store) return;

  // Default to false -- user must explicitly enable notifications.
  const enabled = store.get<boolean>(StoreKey.NotificationEnabled) ?? false;
  if (!enabled) return;

  const isSuccess = run.status === TaskStatus.Success;
  const title = isSuccess
    ? t('notificationTaskComplete', { name: run.taskName })
    : t('notificationTaskFailed', { name: run.taskName });
  const body = isSuccess
    ? t('notificationTaskCompleteBody')
    : t('notificationTaskFailedBody', { error: run.error || '' });

  const iconPath = getNotificationIconPath();
  const notification = new Notification({
    title,
    body,
    ...(iconPath ? { icon: nativeImage.createFromPath(iconPath) } : {}),
  });

  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  notification.show();
}

export function initCronJobServiceManager(d: CronJobServiceDeps): void {
  deps = d;
}

export function getCronJobService(): CronJobService {
  if (!cronJobService) {
    if (!deps) {
      throw new Error(
        'CronJobServiceManager not initialized. Call initCronJobServiceManager() first.',
      );
    }
    const adapter = deps.getOpenClawRuntimeAdapter();
    if (!adapter) {
      throw new Error(
        'OpenClaw runtime adapter not initialized. CronJobService requires OpenClaw.',
      );
    }
    cronJobService = new CronJobService({
      getGatewayClient: () => adapter.getGatewayClient(),
      ensureGatewayReady: () => adapter.ensureReady(),
      onRunCompleted: showRunNotification,
    });
  }
  return cronJobService;
}
