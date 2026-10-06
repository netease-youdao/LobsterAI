import { describe, expect, test } from 'vitest';

import { DeliveryMode } from '../../../scheduledTask/constants';
import type { ScheduledTask, ScheduledTaskConversationOption } from '../../../scheduledTask/types';
import { i18nService } from '../../services/i18n';
import {
  channelOptionMatchesSelection,
  conversationOptionMatchesValue,
  formatDateTimeMinute,
  formatDeliveryLabel,
  formatElapsedDuration,
  getTaskDisplayStatus,
  stripCronMetadataPrefix,
  TaskDisplayStatus,
} from './utils';

function makeTask(overrides: {
  enabled?: boolean;
  runningAtMs?: number | null;
  lastStatus?: ScheduledTask['state']['lastStatus'];
}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Task',
    description: '',
    enabled: overrides.enabled ?? true,
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'hello' },
    delivery: { mode: 'none' },
    agentId: null,
    sessionKey: null,
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: overrides.lastStatus ?? null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: overrides.runningAtMs ?? null,
      consecutiveErrors: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ScheduledTask;
}

describe('getTaskDisplayStatus', () => {
  test('running wins over everything, including paused', () => {
    expect(getTaskDisplayStatus(makeTask({ runningAtMs: 123, enabled: false }))).toBe(
      TaskDisplayStatus.Running,
    );
    expect(getTaskDisplayStatus(makeTask({ lastStatus: 'running' }))).toBe(
      TaskDisplayStatus.Running,
    );
  });

  test('disabled task shows paused regardless of last result', () => {
    expect(getTaskDisplayStatus(makeTask({ enabled: false, lastStatus: 'error' }))).toBe(
      TaskDisplayStatus.Paused,
    );
  });

  test('enabled task reflects the last run result', () => {
    expect(getTaskDisplayStatus(makeTask({ lastStatus: 'success' }))).toBe(
      TaskDisplayStatus.Success,
    );
    expect(getTaskDisplayStatus(makeTask({ lastStatus: 'error' }))).toBe(TaskDisplayStatus.Error);
    expect(getTaskDisplayStatus(makeTask({ lastStatus: 'skipped' }))).toBe(
      TaskDisplayStatus.Skipped,
    );
  });

  test('enabled task without any run shows never', () => {
    expect(getTaskDisplayStatus(makeTask({}))).toBe(TaskDisplayStatus.Never);
  });
});

describe('formatElapsedDuration', () => {
  test('formats seconds, minutes and hours', () => {
    expect(formatElapsedDuration(0)).toBe('0s');
    expect(formatElapsedDuration(42_000)).toBe('42s');
    expect(formatElapsedDuration(3 * 60_000 + 12_000)).toBe('3m 12s');
    expect(formatElapsedDuration(65 * 60_000)).toBe('1h 05m');
  });

  test('handles invalid input', () => {
    expect(formatElapsedDuration(-5)).toBe('0s');
    expect(formatElapsedDuration(Number.NaN)).toBe('0s');
  });
});

describe('conversationOptionMatchesValue', () => {
  const conversationId = 'weixin-bot-1:direct:wxid_zhangsan@im.wechat';

  test('matches the saved bare peer id regardless of casing', () => {
    // Saved targets carry the channel-native casing while conversation ids
    // derive from lowercased OpenClaw session keys.
    expect(
      conversationOptionMatchesValue(
        'openclaw-weixin',
        conversationId,
        'WxId_ZhangSan@im.wechat',
      ),
    ).toBe(true);
  });

  test('matches full conversation ids and trailing segments', () => {
    expect(conversationOptionMatchesValue('openclaw-weixin', conversationId, conversationId)).toBe(
      true,
    );
    expect(
      conversationOptionMatchesValue(
        'openclaw-weixin',
        conversationId,
        'direct:wxid_zhangsan@im.wechat',
      ),
    ).toBe(true);
  });

  test('rejects different peers and empty values', () => {
    expect(
      conversationOptionMatchesValue('openclaw-weixin', conversationId, 'someone-else@im.wechat'),
    ).toBe(false);
    expect(conversationOptionMatchesValue('openclaw-weixin', conversationId, '')).toBe(false);
  });
});

describe('channelOptionMatchesSelection', () => {
  test('single-instance options match regardless of the saved accountId', () => {
    const option = { value: 'openclaw-weixin', label: 'WeChat' };
    expect(channelOptionMatchesSelection(option, 'openclaw-weixin', undefined)).toBe(true);
    expect(channelOptionMatchesSelection(option, 'openclaw-weixin', 'weixin-bot-1')).toBe(
      true,
    );
    expect(channelOptionMatchesSelection(option, 'telegram', undefined)).toBe(false);
  });

  test('multi-instance options require the exact accountId', () => {
    const option = { value: 'feishu', label: '生产实例', accountId: '5ba0851a' };
    expect(channelOptionMatchesSelection(option, 'feishu', '5ba0851a')).toBe(true);
    expect(channelOptionMatchesSelection(option, 'feishu', 'other')).toBe(false);
    expect(channelOptionMatchesSelection(option, 'feishu', undefined)).toBe(false);
  });
});

describe('formatDeliveryLabel', () => {
  const conversation: ScheduledTaskConversationOption = {
    conversationId: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
    platform: 'weixin',
    coworkSessionId: 'session-1',
    lastActiveAt: 1,
    peerKind: 'direct',
    displayName: '张三',
  };

  test('resolves the saved target to the friendly conversation name', () => {
    const label = formatDeliveryLabel(
      {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'WxId_ZhangSan@im.wechat',
      },
      { conversations: [conversation] },
    );
    expect(label).toContain('张三');
    expect(label).not.toContain('WxId_ZhangSan');
  });

  test('falls back to the parsed target when no conversation matches', () => {
    const label = formatDeliveryLabel(
      { mode: DeliveryMode.Announce, channel: 'openclaw-weixin', to: 'someone-else@im.wechat' },
      { conversations: [conversation] },
    );
    expect(label).toContain('someone-else');
  });

  test('shows the channel instance name the form picker uses, without mode jargon', () => {
    const channels = [
      { value: 'feishu', label: '1 号', accountId: 'acc-1' },
      { value: 'feishu', label: '2 号', accountId: 'acc-2' },
    ];
    const label = formatDeliveryLabel(
      { mode: DeliveryMode.Announce, channel: 'feishu', accountId: 'acc-2', to: 'wangning' },
      { channels },
    );
    expect(label).toContain('2 号');
    expect(label).toContain('wangning');
    expect(label).not.toContain(i18nService.t('scheduledTasksFormDeliveryModeAnnounce'));
  });
});

describe('formatDateTimeMinute', () => {
  test('drops seconds from the rendered timestamp', () => {
    const label = formatDateTimeMinute(new Date(2026, 6, 6, 13, 0, 59));
    expect(label).toMatch(/\d{1,2}:\d{2}/);
    expect(label).not.toContain(':59');
  });
});

describe('stripCronMetadataPrefix', () => {
  test('removes the cron routing tag from the prompt', () => {
    expect(
      stripCronMetadataPrefix('[cron:e49b2a3b-0030 科技早报] 请收集并总结新闻'),
    ).toBe('请收集并总结新闻');
  });

  test('keeps text without a cron tag unchanged', () => {
    expect(stripCronMetadataPrefix('普通消息 [cron:not-a-prefix]')).toBe(
      '普通消息 [cron:not-a-prefix]',
    );
  });

  test('only strips the leading tag, not later brackets', () => {
    expect(stripCronMetadataPrefix('[cron:id name] keep [this]')).toBe('keep [this]');
  });
});
