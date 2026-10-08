import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  DeliveryMode,
  PayloadKind,
  RunDeliveryStatus,
  ScheduleKind,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../../scheduledTask/constants';
import { hasRunDeliveryFailure } from '../../../scheduledTask/runDelivery';
import type { ScheduledTask, ScheduledTaskRun } from '../../../scheduledTask/types';
import { sanitizeWeixinDeliveryError, WeixinDeliveryError, WeixinPlugin } from '../../../shared/im/weixin';
import { i18nService } from '../../services/i18n';
import RunDeliveryNotice, { getWeixinDeliveryHint } from './RunDeliveryNotice';

const run: ScheduledTaskRun = {
  id: 'run-1', taskId: 'job-1', sessionId: null, sessionKey: null,
  status: TaskStatus.Success, startedAt: '', finishedAt: '', durationMs: 1, error: null,
  summary: 'Saved report', deliveryStatus: RunDeliveryStatus.NotDelivered,
  deliveryChannel: WeixinPlugin.Id,
};

describe('report generation and delivery are shown separately', () => {
  test('shows delivery failure even with a successful generation and no deliveryError text', () => {
    expect(hasRunDeliveryFailure(run)).toBe(true);
    const html = renderToStaticMarkup(React.createElement(RunDeliveryNotice, { run }));
    expect(html).toContain(i18nService.t('scheduledTasksReportReadyDeliveryFailed'));
    expect(html).not.toContain('<button');
  });

  test('explains the expired Weixin session for ret=-2 and keeps other rejections generic', () => {
    const error = sanitizeWeixinDeliveryError(`Error: ${WeixinDeliveryError.Rejected} ret=-2 errcode=0 secret`);
    expect(getWeixinDeliveryHint(error)).toBe('scheduledTasksWeixinSessionExpired');
    expect(getWeixinDeliveryHint(`${WeixinDeliveryError.Rejected} ret=-3 errcode=0`))
      .toBe('scheduledTasksWeixinRejected');
    expect(getWeixinDeliveryHint(`${WeixinDeliveryError.ContextExpired} ret=-2 errcode=0`))
      .toBe('scheduledTasksWeixinContextExpired');
    expect(getWeixinDeliveryHint(`${WeixinDeliveryError.AccountExpired} ret=0 errcode=-14`))
      .toBe('scheduledTasksWeixinAccountExpired');
  });

  test('renders the expired-session guidance for a ret=-2 Weixin report delivery', () => {
    const task: ScheduledTask = {
      id: run.taskId, name: 'Report', description: '', enabled: true,
      schedule: { kind: ScheduleKind.Cron, expr: '0 9 * * *' },
      sessionTarget: SessionTarget.Isolated, wakeMode: WakeMode.Now,
      payload: { kind: PayloadKind.AgentTurn, message: 'Generate report' },
      delivery: { mode: DeliveryMode.Announce, channel: WeixinPlugin.Id, to: 'recipient@im.wechat' },
      agentId: null, sessionKey: null, createdAt: '', updatedAt: '',
      state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runningAtMs: null, consecutiveErrors: 0 },
    };
    const expired = { ...run, deliveryError: `${WeixinDeliveryError.Rejected} ret=-2 errcode=0` };
    const html = renderToStaticMarkup(React.createElement(RunDeliveryNotice, { run: expired, task }));
    expect(html).toContain(i18nService.t('scheduledTasksWeixinSessionExpired'));
    expect(html).not.toContain(i18nService.t('scheduledTasksWeixinRejected'));
  });

  test('does not reintroduce stale mode:none delivery errors or change other channel UI', () => {
    const other = { ...run, deliveryChannel: null, deliveryError: 'Message failed' };
    expect(hasRunDeliveryFailure(other, { mode: DeliveryMode.None })).toBe(false);
    expect(hasRunDeliveryFailure({ ...other, deliveryChannel: 'telegram' })).toBe(false);
    expect(hasRunDeliveryFailure({ ...other, deliveryError: `${WeixinDeliveryError.Rejected} ret=-2` })).toBe(true);
  });

  test('hides arbitrary server messages and unknown code prefixes', () => {
    expect(sanitizeWeixinDeliveryError('token=private; request failed')).toBe(WeixinDeliveryError.Unknown);
    expect(sanitizeWeixinDeliveryError('WEIXIN_SEND_REJECTED_SECRET')).toBe(WeixinDeliveryError.Unknown);
  });
});
