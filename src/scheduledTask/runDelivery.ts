import { WeixinDeliveryError, WeixinPlugin } from '../shared/im/weixin';
import { PlatformRegistry } from '../shared/platform';
import { DeliveryMode, RunDeliveryStatus, TaskStatus } from './constants';
import type { ScheduledTaskDelivery, ScheduledTaskRun } from './types';

export function hasRunDeliveryFailure(run: ScheduledTaskRun, delivery?: ScheduledTaskDelivery): boolean {
  const channel = run.deliveryChannel
    ?? (delivery?.mode === DeliveryMode.Announce ? delivery.channel : undefined);
  const weixin = channel === WeixinPlugin.Id || channel === PlatformRegistry.platformOfChannel(WeixinPlugin.Id);
  const hasWeixinError = Object.values(WeixinDeliveryError).some(code => run.deliveryError?.includes(code));
  // Keep this recovery change scoped to Weixin. In particular, old mode:none
  // jobs can carry stale delivery-only errors that the product already ignores.
  return (weixin || hasWeixinError)
    && (Boolean(run.deliveryError) || run.deliveryStatus === RunDeliveryStatus.NotDelivered);
}

export function isWeixinReportDelivery(delivery: ScheduledTaskDelivery): boolean {
  return delivery.mode === DeliveryMode.Announce
    && Boolean(delivery.to?.trim())
    && (delivery.channel === WeixinPlugin.Id
      || delivery.channel === PlatformRegistry.platformOfChannel(WeixinPlugin.Id));
}

export function hasResendableReport(run: ScheduledTaskRun): boolean {
  return run.status === TaskStatus.Success && Boolean(run.summary?.trim());
}
