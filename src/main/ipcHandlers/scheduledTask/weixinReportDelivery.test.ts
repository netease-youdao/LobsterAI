import { describe, expect, test, vi } from 'vitest';

import { DeliveryMode, PayloadKind, RunDeliveryStatus, ScheduleKind, SessionTarget, TaskStatus, WakeMode } from '../../../scheduledTask/constants';
import type { ScheduledTask, ScheduledTaskRun } from '../../../scheduledTask/types';
import { AgentId } from '../../../shared/agent/constants';
import { WeixinDeliveryError, WeixinPlugin } from '../../../shared/im/weixin';
import { WeixinReportDelivery } from './weixinReportDelivery';

const task: ScheduledTask = {
  id: 'job-1', name: 'Report', description: '', enabled: true,
  schedule: { kind: ScheduleKind.Cron, expr: '0 9 * * *' },
  sessionTarget: SessionTarget.Isolated, wakeMode: WakeMode.Now,
  payload: { kind: PayloadKind.AgentTurn, message: 'Generate report' },
  delivery: { mode: DeliveryMode.Announce, channel: WeixinPlugin.Id, to: 'recipient@im.wechat', accountId: 'account-1' },
  agentId: null, sessionKey: null, createdAt: '', updatedAt: '',
  state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runningAtMs: null, consecutiveErrors: 0 },
};
const report: ScheduledTaskRun = {
  id: 'job-1-123', taskId: task.id, sessionId: null, sessionKey: null,
  status: TaskStatus.Success, startedAt: '', finishedAt: '', durationMs: 1000, error: null,
  summary: 'The original saved report', deliveryStatus: RunDeliveryStatus.NotDelivered,
  deliveryError: `${WeixinDeliveryError.Rejected} ret=-2 errcode=0`,
};

function makeDelivery(taskOverride: Partial<ScheduledTask> = {}, runOverride: Partial<ScheduledTaskRun> = {}) {
  const deps = {
    getJob: vi.fn(async () => ({ ...task, ...taskOverride })),
    listRuns: vi.fn(async () => [{ ...report, ...runOverride }]),
    send: vi.fn(async () => ({ messageId: 'accepted-1' })),
  };
  return { deps, delivery: new WeixinReportDelivery(deps) };
}

describe('manual Weixin report recovery', () => {
  test('sends stored text to the configured Weixin account without starting an agent or cron run', async () => {
    const { deps, delivery } = makeDelivery();
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledExactlyOnceWith({
      channel: WeixinPlugin.Id, to: task.delivery.to, accountId: task.delivery.accountId,
      agentId: AgentId.Main, message: report.summary, idempotencyKey: expect.any(String),
    });
    expect(report.deliveryStatus).toBe(RunDeliveryStatus.NotDelivered);
    expect(report.summary).toBe('The original saved report');
  });

  test('collapses concurrent clicks and retains the accepted receipt for repeat clicks', async () => {
    const { deps, delivery } = makeDelivery();
    await Promise.all([delivery.resend(task.id, report.id), delivery.resend(task.id, report.id)]);
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  test('keeps the task agent for outbound routing', async () => {
    const { deps, delivery } = makeDelivery({ agentId: 'report-agent' });
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'report-agent' }));
  });

  test('names the main agent for main-agent jobs so multi-agent gateways accept the send', async () => {
    const { deps, delivery } = makeDelivery({ agentId: null });
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ agentId: AgentId.Main }));
  });

  test('allows recovery of old runs that were incorrectly marked delivered', async () => {
    const { deps, delivery } = makeDelivery({}, { deliveryStatus: RunDeliveryStatus.Delivered, deliveryError: null });
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  test('preserves the report after rejection and allows a new explicit attempt', async () => {
    const { deps, delivery } = makeDelivery();
    deps.send.mockRejectedValueOnce(new Error(`${WeixinDeliveryError.ContextExpired} ret=-2 errcode=0 secret-context`));
    await expect(delivery.resend(task.id, report.id)).rejects.toThrow(`${WeixinDeliveryError.ContextExpired} ret=-2 errcode=0`);
    await delivery.resend(task.id, report.id);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.send.mock.calls[0][0].idempotencyKey).not.toBe(deps.send.mock.calls[1][0].idempotencyKey);
    expect(deps.send.mock.calls[1][0].message).toBe(report.summary);
  });

  test.each([
    { summary: null }, { status: TaskStatus.Running }, { status: TaskStatus.Error }, { taskId: 'another-job' },
  ])('rejects missing, incomplete, or wrong-job reports', async override => {
    const { deps, delivery } = makeDelivery({}, override);
    await expect(delivery.resend(task.id, report.id)).rejects.toThrow(WeixinDeliveryError.ReportUnavailable);
    expect(deps.send).not.toHaveBeenCalled();
  });

  test('rejects non-Weixin delivery and unrecognized run IDs', async () => {
    const other = makeDelivery({ delivery: { mode: DeliveryMode.Announce, channel: 'telegram', to: 'somewhere' } });
    await expect(other.delivery.resend(task.id, report.id)).rejects.toThrow(WeixinDeliveryError.ReportUnavailable);
    expect(other.deps.send).not.toHaveBeenCalled();
    const missing = makeDelivery();
    await expect(missing.delivery.resend(task.id, 'made-up-run')).rejects.toThrow(WeixinDeliveryError.ReportUnavailable);
    expect(missing.deps.send).not.toHaveBeenCalled();
  });

  test('does not claim success for an empty delivery result or expose network secrets', async () => {
    const { deps, delivery } = makeDelivery();
    deps.send.mockResolvedValueOnce({ messageId: '' });
    await expect(delivery.resend(task.id, report.id)).rejects.toThrow(WeixinDeliveryError.Unknown);
    deps.send.mockRejectedValueOnce(new Error('http://user:secret@host request failed'));
    await expect(delivery.resend(task.id, report.id)).rejects.toThrow(WeixinDeliveryError.Unknown);
  });
});
