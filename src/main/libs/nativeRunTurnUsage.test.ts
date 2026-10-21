import { beforeEach, describe, expect, test } from 'vitest';

import { isValidLlmTraceId } from '../../shared/cowork/llmTurnUsage';
import { clearLlmUsageContexts, configureUsageTitleReporter, getLlmUsageHeaders, LlmUsageHeader, registerLlmUsageContext } from './llmUsageContext';
import {
  bindNativeRunUsageOwner,
  claimNativeRunTurnUsage,
  clearNativeRunTurnUsage,
  configureNativeUsageSessionTitleResolver,
  getNativeRunMediaUsageContext,
  recordNativeRunLlmTrace,
  recordNativeRunMediaTask,
} from './nativeRunTurnUsage';

const TRACE_A = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE_B = '11112222333344445555666677778888';

describe('nativeRunTurnUsage', () => {
  beforeEach(() => {
    clearNativeRunTurnUsage();
    clearLlmUsageContexts();
    configureNativeUsageSessionTitleResolver(() => undefined);
    configureUsageTitleReporter(() => {});
  });

  test('claims the traces of a run once, the earliest run first', () => {
    expect(recordNativeRunLlmTrace({ runId: 'run-2', traceId: TRACE_B }, 2_000)).toBe(true);
    expect(recordNativeRunLlmTrace({ runId: 'run-1', traceId: TRACE_A }, 1_000)).toBe(true);
    expect(recordNativeRunLlmTrace({ runId: 'run-1', traceId: TRACE_A }, 1_500)).toBe(true);

    expect(claimNativeRunTurnUsage(['run-1', 'run-2', 'unknown'])).toEqual({
      trace: { traceId: TRACE_A, startedAt: 1_000, relatedTraceIds: [TRACE_B] },
      mediaTaskIds: [],
    });
    expect(claimNativeRunTurnUsage(['run-1', 'run-2'])).toBeNull();
  });

  test('binds overlapping IM turns before requests without borrowing a model prompt', () => {
    const report = { sessionKey: 'agent:main:openclaw-weixin:group:chat-123', sessionId: 'runtime-session', trigger: 'user' };
    const titles: string[] = [];
    configureUsageTitleReporter((_id, title) => { if (title) titles.push(title); });
    recordNativeRunLlmTrace({ ...report, runId: 'first', traceId: TRACE_A, userMessage: '北京天气如何' }, 1, 'owner-1');
    recordNativeRunLlmTrace({ ...report, runId: 'second', traceId: TRACE_B, userMessage: '上海呢' }, 2, 'owner-1');
    const first = getLlmUsageHeaders(`00-${TRACE_A}-1111111111111111-01`, undefined, 'owner-1');
    const second = getLlmUsageHeaders(`00-${TRACE_B}-1111111111111111-01`, undefined, 'owner-1');
    expect(first[LlmUsageHeader.Session]).toMatch(/^im:weixin:[a-f0-9]{64}$/);
    expect(first[LlmUsageHeader.Session]).toBe(second[LlmUsageHeader.Session]);
    expect(decodeURIComponent(first[LlmUsageHeader.UserMessage])).toBe('北京天气如何');
    expect(decodeURIComponent(second[LlmUsageHeader.UserMessage])).toBe('上海呢');
    expect(titles).toEqual(['group:chat-123', 'group:chat-123']);
    expect(getNativeRunMediaUsageContext('first', 'owner-1')).toEqual({ sessionId: first[LlmUsageHeader.Session], turnId: TRACE_A, userMessage: '北京天气如何' });
    // The later fire-and-forget trace notification has no input and must retain the original.
    recordNativeRunLlmTrace({ runId: 'first', traceId: TRACE_A }, 3, 'owner-1');
    expect(getNativeRunMediaUsageContext('first', 'owner-1')?.userMessage).toBe('北京天气如何');
    expect(getLlmUsageHeaders(`00-${TRACE_A}-1111111111111111-01`, undefined, 'owner-2')).toEqual({});
    expect(getNativeRunMediaUsageContext('first', 'owner-2')).toBeUndefined();
    expect(recordNativeRunLlmTrace({ ...report, runId: 'first', traceId: TRACE_A, userMessage: 'other account' }, 4, 'owner-2')).toBe(false);
  });

  test('keeps IM grouping across transcript resets and separates channel accounts and threads', () => {
    const report = { sessionKey: 'agent:main:telegram:bot-1:direct:123', trigger: 'user', userMessage: 'hello' };
    const idFor = (runId: string, sessionKey: string, sessionId: string) => {
      clearLlmUsageContexts();
      recordNativeRunLlmTrace({ ...report, runId, traceId: TRACE_A, sessionKey, sessionId });
      return getNativeRunMediaUsageContext(runId)?.sessionId;
    };
    const original = idFor('first', report.sessionKey, 'transcript-1');
    expect(idFor('reset', report.sessionKey, 'transcript-2')).toBe(original);
    expect(idFor('account', 'agent:main:telegram:bot-2:direct:123', 'transcript-1')).not.toBe(original);
    expect(idFor('thread', `${report.sessionKey}:thread:456`, 'transcript-1')).not.toBe(original);
    expect(idFor('agent', 'agent:other:telegram:bot-1:direct:123', 'transcript-1')).not.toBe(original);
  });

  test('cannot reassign a run when the account changes before its first model call', () => {
    bindNativeRunUsageOwner('run', 'original-account');
    bindNativeRunUsageOwner('run', 'new-account');
    expect(recordNativeRunLlmTrace({ runId: 'run', traceId: TRACE_A }, 1, 'new-account')).toBe(false);
    expect(recordNativeRunLlmTrace({ runId: 'run', traceId: TRACE_A }, 2, 'original-account')).toBe(true);
  });

  test('uses scheduled task name and instruction with a separate turn for every execution', () => {
    const report = { sessionKey: 'agent:main:cron:job-1:run:execution', trigger: 'cron', jobId: 'job-1', jobTitle: '报数', userMessage: '每1分钟报一下当前时间' };
    const titles: string[] = [];
    configureUsageTitleReporter((_id, title) => { if (title) titles.push(title); });
    recordNativeRunLlmTrace({ ...report, runId: 'first', traceId: TRACE_A });
    configureNativeUsageSessionTitleResolver((key, jobId) => {
      expect(key).toBe(report.sessionKey);
      expect(jobId).toBe('job-1');
      return '已有会话标题';
    });
    recordNativeRunLlmTrace({ ...report, runId: 'second', traceId: TRACE_B, messageProvider: 'webchat' });
    expect(titles).toEqual(['报数', '已有会话标题']);
    expect(getNativeRunMediaUsageContext('first')).toEqual({ sessionId: 'cron:job-1', turnId: TRACE_A, userMessage: report.userMessage });
    expect(getNativeRunMediaUsageContext('second')?.turnId).toBe(TRACE_B);
  });

  test('preserves empty input and excludes desktop continuations and heartbeat runs', () => {
    const report = { sessionKey: 'agent:main:telegram:direct:123', sessionId: 'runtime', trigger: 'user' };
    recordNativeRunLlmTrace({ ...report, runId: 'attachment', traceId: TRACE_A });
    expect(getLlmUsageHeaders(`00-${TRACE_A}-1111111111111111-01`)[LlmUsageHeader.UserMessage]).toBe('');
    recordNativeRunLlmTrace({ ...report, runId: 'desktop', traceId: TRACE_B, messageProvider: 'webchat' });
    expect(getNativeRunMediaUsageContext('desktop')).toBeUndefined();
    recordNativeRunLlmTrace({ ...report, runId: 'heartbeat', traceId: TRACE_B, trigger: 'heartbeat' });
    expect(getNativeRunMediaUsageContext('heartbeat')).toBeUndefined();
  });

  test('ignores invalid reports and traces of desktop turns', () => {
    registerLlmUsageContext(TRACE_A, 'desktop-session', 'hello');

    expect(recordNativeRunLlmTrace({ runId: 'run-1', traceId: TRACE_A })).toBe(false);
    expect(recordNativeRunLlmTrace({ runId: 'run-1', traceId: 'not-a-trace' })).toBe(false);
    expect(recordNativeRunLlmTrace({ runId: '', traceId: TRACE_B })).toBe(false);
    expect(recordNativeRunLlmTrace({ runId: 42, traceId: TRACE_B })).toBe(false);
    expect(claimNativeRunTurnUsage(['run-1'])).toBeNull();
  });

  test('keeps the preset a run resolved with the model it resolved to', () => {
    recordNativeRunLlmTrace({ runId: 'run-1', traceId: TRACE_A, model: 'deepseek-flash-YoudaoInner', virtualModelId: 'yd-fast' }, 1);
    recordNativeRunLlmTrace({ runId: 'run-1', traceId: TRACE_B, model: 'glm-5', virtualModelId: 'yd-ultra' }, 2);
    recordNativeRunLlmTrace({ runId: 'run-2', traceId: TRACE_A, model: 'yd-fast', virtualModelId: 'yd-fast' }, 3);
    recordNativeRunLlmTrace({ runId: 'run-3', traceId: TRACE_B, model: 'glm-5' }, 4);

    expect(claimNativeRunTurnUsage(['run-1'])?.modelPreset)
      .toEqual({ modelPresetId: 'balanced', resolvedModelId: 'deepseek-flash-YoudaoInner' });
    expect(claimNativeRunTurnUsage(['run-2'])?.modelPreset).toBeUndefined();
    expect(claimNativeRunTurnUsage(['run-3'])?.modelPreset).toBeUndefined();
  });

  test('keeps media tasks and gives a media-only run its own lookup trace', () => {
    recordNativeRunMediaTask('run-1', 42, 3_000);
    recordNativeRunMediaTask('run-1', '42', 3_100);
    recordNativeRunMediaTask('run-1', 'abc', 3_200);

    const usage = claimNativeRunTurnUsage(['run-1']);

    expect(usage?.mediaTaskIds).toEqual(['42']);
    expect(usage?.trace.startedAt).toBe(3_000);
    expect(isValidLlmTraceId(usage?.trace.traceId)).toBe(true);
    expect(usage?.trace.relatedTraceIds).toBeUndefined();
  });

  test('drops the least recently used runs beyond the limit', () => {
    recordNativeRunLlmTrace({ runId: 'oldest', traceId: TRACE_A }, 1);
    for (let index = 0; index < 256; index += 1) {
      recordNativeRunLlmTrace({ runId: `run-${index}`, traceId: TRACE_B }, 2);
    }

    expect(claimNativeRunTurnUsage(['oldest'])).toBeNull();
    expect(claimNativeRunTurnUsage(['run-255'])?.trace.traceId).toBe(TRACE_B);
  });
});
