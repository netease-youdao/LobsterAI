import { test, expect } from 'vitest';
import { analyzeIMReply, UNSCHEDULED_REMINDER_FAILURE_REPLY, FAILED_REMINDER_FAILURE_REPLY } from './imReplyGuard';

test('guards IM reminder commitment when no cron.add succeeded', () => {
  const analysis = analyzeIMReply([
    {
      id: 'assistant-1',
      type: 'assistant',
      content: '好的，2分钟后会提醒你喝饮料。',
      timestamp: Date.now(),
      metadata: {},
    },
  ]);

  expect(analysis.guardApplied).toBe(true);
  expect(analysis.successfulCronAdds).toBe(0);
  expect(analysis.text).toBe(UNSCHEDULED_REMINDER_FAILURE_REPLY);
});

test('preserves reminder reply when cron.add completed successfully', () => {
  const analysis = analyzeIMReply([
    {
      id: 'tool-use-1',
      type: 'tool_use',
      content: 'Using tool: cron',
      timestamp: Date.now(),
      metadata: {
        toolName: 'cron',
        toolUseId: 'cron-call-1',
        toolInput: { action: 'add' },
      },
    },
    {
      id: 'tool-result-1',
      type: 'tool_result',
      content: '{"id":"job-1"}',
      timestamp: Date.now(),
      metadata: {
        toolUseId: 'cron-call-1',
        toolResult: '{"id":"job-1"}',
        isError: false,
      },
    },
    {
      id: 'assistant-1',
      type: 'assistant',
      content: '好的，2分钟后会提醒你喝饮料。',
      timestamp: Date.now(),
      metadata: {},
    },
  ]);

  expect(analysis.guardApplied).toBe(false);
  expect(analysis.successfulCronAdds).toBe(1);
  expect(analysis.text).toBe('好的，2分钟后会提醒你喝饮料。');
});

test('returns explicit failure when cron.add was attempted but failed', () => {
  const analysis = analyzeIMReply([
    {
      id: 'tool-use-1',
      type: 'tool_use',
      content: 'Using tool: cron',
      timestamp: Date.now(),
      metadata: {
        toolName: 'Cron',
        toolUseId: 'cron-call-1',
        toolInput: { action: 'add' },
      },
    },
    {
      id: 'tool-result-1',
      type: 'tool_result',
      content: 'invalid cron.add params',
      timestamp: Date.now(),
      metadata: {
        toolUseId: 'cron-call-1',
        toolResult: 'invalid cron.add params',
        error: 'invalid cron.add params',
        isError: true,
      },
    },
    {
      id: 'assistant-1',
      type: 'assistant',
      content: '定时任务创建成功！到时间后我会自动提醒你。',
      timestamp: Date.now(),
      metadata: {},
    },
  ]);

  expect(analysis.guardApplied).toBe(true);
  expect(analysis.attemptedCronAdds).toBe(1);
  expect(analysis.successfulCronAdds).toBe(0);
  expect(analysis.text).toBe(FAILED_REMINDER_FAILURE_REPLY);
});

test('does not guard normal non-reminder assistant replies', () => {
  const analysis = analyzeIMReply([
    {
      id: 'assistant-1',
      type: 'assistant',
      content: '今天上海多云，气温 18 到 24 度。',
      timestamp: Date.now(),
      metadata: {},
    },
  ]);

  expect(analysis.guardApplied).toBe(false);
  expect(analysis.text).toBe('今天上海多云，气温 18 到 24 度。');
});
