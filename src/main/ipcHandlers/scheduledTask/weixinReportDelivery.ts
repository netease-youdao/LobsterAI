import { createHash, randomUUID } from 'node:crypto';

import { hasResendableReport, isWeixinReportDelivery } from '../../../scheduledTask/runDelivery';
import type { ScheduledTask, ScheduledTaskRun } from '../../../scheduledTask/types';
import { AgentId } from '../../../shared/agent/constants';
import { sanitizeWeixinDeliveryError, WeixinDeliveryError, WeixinPlugin } from '../../../shared/im/weixin';

export type WeixinReportDeliveryDeps = {
  getJob: (id: string) => Promise<ScheduledTask | null>;
  listRuns: (id: string, limit: number, offset: number) => Promise<ScheduledTaskRun[]>;
  send: (params: {
    channel: string;
    to: string;
    accountId?: string;
    agentId?: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<{ messageId?: string }>;
};

/** Manual recovery sends only the saved report; it never invokes cron.run or an agent. */
export class WeixinReportDelivery {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly accepted = new Set<string>();

  constructor(private readonly deps: WeixinReportDeliveryDeps) {}

  async resend(taskId: string, runId: string): Promise<void> {
    if (typeof taskId !== 'string' || typeof runId !== 'string' || !taskId || !runId) {
      throw new Error(WeixinDeliveryError.ReportUnavailable);
    }
    const key = JSON.stringify([taskId, runId]);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const send = this.sendReport(taskId, runId);
    this.inFlight.set(key, send);
    try {
      await send;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async sendReport(taskId: string, runId: string): Promise<void> {
    const task = await this.deps.getJob(taskId);
    if (!task || !isWeixinReportDelivery(task.delivery)) {
      throw new Error(WeixinDeliveryError.ReportUnavailable);
    }
    // Read authoritative history. Renderer input cannot choose message content or recipient.
    let run: ScheduledTaskRun | undefined;
    for (let offset = 0; ; offset += 200) {
      const page = await this.deps.listRuns(taskId, 200, offset);
      run = page.find(entry => entry.id === runId && entry.taskId === taskId);
      if (run || page.length < 200) break;
    }
    if (!run || !hasResendableReport(run)) {
      throw new Error(WeixinDeliveryError.ReportUnavailable);
    }
    const message = run.summary!.trim();
    const receiptKey = createHash('sha256')
      .update(JSON.stringify([taskId, runId, task.delivery.to, task.delivery.accountId, message]))
      .digest('hex');
    if (this.accepted.has(receiptKey)) return;
    try {
      const result = await this.deps.send({
        channel: WeixinPlugin.Id,
        to: task.delivery.to!,
        ...(task.delivery.accountId ? { accountId: task.delivery.accountId } : {}),
        // The gateway refuses an ownerless send once several agents exist, so
        // main-agent jobs (stored without an agent id) must name the main agent.
        agentId: task.agentId?.trim() || AgentId.Main,
        message,
        idempotencyKey: randomUUID(),
      });
      if (!result.messageId?.trim()) throw new Error(WeixinDeliveryError.Unknown);
      this.accepted.add(receiptKey);
      console.log('[WeixinReportDelivery] saved report accepted:', { taskId, runId });
    } catch (error) {
      const safeError = new Error(sanitizeWeixinDeliveryError(error));
      console.error('[WeixinReportDelivery] saved report delivery failed:', { taskId, runId }, safeError);
      throw safeError;
    }
  }
}
