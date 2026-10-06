import { describe, expect, test } from 'vitest';

import { DeliveryMode, PayloadKind, ScheduleKind, SessionTarget, WakeMode } from '../../../scheduledTask/constants';
import type { ScheduledTask, ScheduledTaskChannelOption } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import { getScheduleAnalyticsParams } from './analytics';
import { createScheduledTaskFormState } from './TaskForm';
import {
  SCHEDULED_TASK_TEMPLATES,
  ScheduledTaskTemplateId,
  ScheduledTaskTemplatePlanType,
} from './taskTemplates';
import {
  conversationOptionMatchesValue,
  formatChannelOptionLabel,
  formatConversationOptionLabel,
  formatDeliveryLabel,
  pickDefaultConversation,
  scheduleToPlanInfo,
} from './utils';

const fallbackModelRef = 'openai/gpt-5.5';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Daily summary',
    description: '',
    enabled: true,
    schedule: { kind: ScheduleKind.Cron, expr: '0 9 * * *' },
    sessionTarget: SessionTarget.Isolated,
    wakeMode: WakeMode.Now,
    payload: { kind: PayloadKind.AgentTurn, message: 'Summarize updates' },
    delivery: { mode: DeliveryMode.None },
    agentId: null,
    sessionKey: null,
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('createScheduledTaskFormState', () => {
  test('uses the fallback model for new tasks', () => {
    const form = createScheduledTaskFormState(undefined, fallbackModelRef);

    expect(form.modelId).toBe(fallbackModelRef);
  });

  test('backfills old agent-turn tasks that do not have a model', () => {
    const form = createScheduledTaskFormState(makeTask(), fallbackModelRef);

    expect(form.modelId).toBe(fallbackModelRef);
  });

  test('keeps an explicit existing task model', () => {
    const form = createScheduledTaskFormState(makeTask({
      payload: {
        kind: PayloadKind.AgentTurn,
        message: 'Summarize updates',
        model: 'anthropic/claude-sonnet-4',
      },
    }), fallbackModelRef);

    expect(form.modelId).toBe('anthropic/claude-sonnet-4');
  });

  test('does not assign a model when editing a system-event task', () => {
    const form = createScheduledTaskFormState(makeTask({
      payload: {
        kind: PayloadKind.SystemEvent,
        text: 'Reminder',
      },
    }), fallbackModelRef);

    expect(form.payloadText).toBe('Reminder');
    expect(form.modelId).toBe('');
  });

  test('applies template defaults for new tasks', () => {
    const template = SCHEDULED_TASK_TEMPLATES.find(
      item => item.id === ScheduledTaskTemplateId.TechBriefing,
    );

    expect(template).toBeDefined();

    const form = createScheduledTaskFormState(undefined, fallbackModelRef, template);

    expect(form.name).toBe(i18nService.t(template!.titleKey));
    expect(form.payloadText).toBe(i18nService.t(template!.promptKey));
    expect(form.planType).toBe(ScheduledTaskTemplatePlanType.Weekly);
    expect(form.hour).toBe(8);
    expect(form.minute).toBe(30);
    expect(form.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(form.modelId).toBe(fallbackModelRef);
  });
});

describe('scheduleToPlanInfo', () => {
  test('parses comma-separated weekdays from cron schedules', () => {
    const planInfo = scheduleToPlanInfo({
      kind: ScheduleKind.Cron,
      expr: '30 8 * * 1,2,3,4,5',
    });

    expect(planInfo.planType).toBe('weekly');
    expect(planInfo.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(planInfo.monthDay).toBe(1);
  });
});

describe('conversationOptionMatchesValue', () => {
  test('matches identical ids', () => {
    expect(conversationOptionMatchesValue('telegram', 'cebef798:direct:123', 'cebef798:direct:123')).toBe(true);
  });

  test('matches a saved bare peer id against the full option id', () => {
    expect(conversationOptionMatchesValue('telegram', 'cebef798:direct:8368898190', '8368898190')).toBe(true);
    expect(conversationOptionMatchesValue('openclaw-weixin', 'direct:wxid_abc@im.wechat', 'wxid_abc@im.wechat')).toBe(true);
  });

  test('keeps the nim pipe-delimited fallback', () => {
    expect(conversationOptionMatchesValue('nim', 'appkey|user1', 'user1')).toBe(true);
    expect(conversationOptionMatchesValue('telegram', 'appkey|user1', 'user1')).toBe(false);
  });

  test('rejects unrelated values', () => {
    expect(conversationOptionMatchesValue('telegram', 'cebef798:direct:123', '456')).toBe(false);
    expect(conversationOptionMatchesValue('telegram', '', '123')).toBe(false);
    expect(conversationOptionMatchesValue('telegram', 'cebef798:direct:123', '')).toBe(false);
  });

  // Regression: a bot present in both a group and a private chat must let the
  // delivery dropdown highlight/select the group without confusing it with the
  // DM sibling (previously the target was auto-resolved and not user-selectable).
  test('disambiguates a group target from a DM sibling on the same bot', () => {
    const groupId = 'bot1:group:zhangsan@popo.example.com';
    const dmId = 'bot1:direct:lisi@popo.example.com';
    expect(conversationOptionMatchesValue('popo', groupId, groupId)).toBe(true);
    expect(conversationOptionMatchesValue('popo', groupId, 'zhangsan@popo.example.com')).toBe(true);
    expect(conversationOptionMatchesValue('popo', groupId, dmId)).toBe(false);
    expect(conversationOptionMatchesValue('popo', dmId, groupId)).toBe(false);
  });
});

describe('formatConversationOptionLabel', () => {
  const baseOption = {
    platform: 'telegram',
    coworkSessionId: 's-1',
    lastActiveAt: 0,
  };

  test('prefers the provided display name with a peer-kind prefix', () => {
    const label = formatConversationOptionLabel({
      ...baseOption,
      conversationId: 'cebef798:direct:8368898190',
      peerKind: 'direct',
      displayName: '张三',
    });
    expect(label).toBe(`${i18nService.t('scheduledTasksConvKindDirect')} · 张三`);
  });

  test('derives name and kind from the conversation id when fields are missing', () => {
    const label = formatConversationOptionLabel({
      ...baseOption,
      conversationId: 'bot1:group:12345@popo.example.com',
    });
    expect(label).toBe(`${i18nService.t('scheduledTasksConvKindGroup')} · 12345`);
  });

  test('renders plain ids without a kind prefix', () => {
    const label = formatConversationOptionLabel({
      ...baseOption,
      conversationId: 'oc_a1b2c3',
    });
    expect(label).toBe('oc_a1b2c3');
  });
});

describe('pickDefaultConversation', () => {
  const conv = (conversationId: string, peerKind?: 'direct' | 'group' | 'channel') => ({
    conversationId,
    platform: 'telegram',
    coworkSessionId: `s-${conversationId}`,
    lastActiveAt: 0,
    ...(peerKind ? { peerKind } : {}),
  });

  test('prefers the most recent direct conversation over groups', () => {
    const picked = pickDefaultConversation([
      conv('acc:group:111', 'group'),
      conv('acc:direct:222', 'direct'),
      conv('acc:direct:333', 'direct'),
    ]);
    expect(picked?.conversationId).toBe('acc:direct:222');
  });

  test('derives the peer kind from the id when the field is missing', () => {
    const picked = pickDefaultConversation([
      conv('acc:group:111'),
      conv('acc:direct:222'),
    ]);
    expect(picked?.conversationId).toBe('acc:direct:222');
  });

  test('falls back to the most recent conversation when no direct exists', () => {
    const picked = pickDefaultConversation([conv('acc:group:111', 'group'), conv('oc_222')]);
    expect(picked?.conversationId).toBe('acc:group:111');
  });

  test('returns undefined for an empty list', () => {
    expect(pickDefaultConversation([])).toBeUndefined();
  });
});

describe('formatChannelOptionLabel', () => {
  const feishu = (accountId: string, label: string): ScheduledTaskChannelOption => ({
    value: 'feishu',
    label,
    accountId,
  });

  test('uses the platform label alone for single-instance options', () => {
    const options = [feishu('acc1', 'My Bot')];
    expect(formatChannelOptionLabel(options[0], options)).toBe(
      i18nService.t('feishu') || 'Feishu',
    );
  });

  test('appends instance names only when multiple instances exist', () => {
    const options = [feishu('acc1', 'Bot A'), feishu('acc2', 'Bot B')];
    const platformLabel = i18nService.t('feishu') || 'Feishu';
    expect(formatChannelOptionLabel(options[0], options)).toBe(`${platformLabel} · Bot A`);
    expect(formatChannelOptionLabel(options[1], options)).toBe(`${platformLabel} · Bot B`);
  });

  test('falls back to an ordinal for unnamed instances instead of account ids', () => {
    const options = [feishu('acc1', ''), feishu('acc2', '')];
    const platformLabel = i18nService.t('feishu') || 'Feishu';
    const instance = i18nService.t('scheduledTasksFormInstanceFallback');
    expect(formatChannelOptionLabel(options[0], options)).toBe(`${platformLabel} · ${instance} 1`);
    expect(formatChannelOptionLabel(options[1], options)).toBe(`${platformLabel} · ${instance} 2`);
  });
});

describe('formatDeliveryLabel', () => {
  test('prettifies announce targets instead of echoing raw ids', () => {
    const label = formatDeliveryLabel({
      mode: DeliveryMode.Announce,
      channel: 'telegram',
      to: 'cebef798:direct:8368898190',
    });
    expect(label).toContain(`${i18nService.t('scheduledTasksConvKindDirect')} · 8368898190`);
    expect(label).not.toContain('cebef798');
  });

  test('keeps webhook urls verbatim', () => {
    const label = formatDeliveryLabel({
      mode: DeliveryMode.Webhook,
      to: 'https://example.com/hook',
    });
    expect(label).toContain('https://example.com/hook');
  });
});

describe('getScheduleAnalyticsParams', () => {
  test('reports weekdays only for weekly cron schedules', () => {
    const params = getScheduleAnalyticsParams({
      kind: ScheduleKind.Cron,
      expr: '30 8 * * 1,2,3,4,5',
    });

    expect(params.planType).toBe('weekly');
    expect(params.weekdayCount).toBe(5);
    expect(params.weekdays).toBe('1,2,3,4,5');
    expect(params.monthDay).toBeUndefined();
  });

  test('reports monthDay only for monthly cron schedules', () => {
    const params = getScheduleAnalyticsParams({
      kind: ScheduleKind.Cron,
      expr: '30 8 15 * *',
    });

    expect(params.planType).toBe('monthly');
    expect(params.monthDay).toBe(15);
    expect(params.weekdayCount).toBeUndefined();
    expect(params.weekdays).toBeUndefined();
  });
});
