import { describe, expect, test, vi } from 'vitest';

import { LogReporterAction } from '../../shared/analytics/constants';
import { UsageEntry, UsageOutcome, UsageStage } from '../../shared/analytics/usage';
import type { CoworkMessage } from '../coworkStore';
import { TaskUsageAnalytics } from './usageAnalytics';

const context = {
  taskId: '00000000-0000-4000-8000-000000000001',
  turnId: '00000000-0000-4000-8000-000000000002',
  journeyId: '00000000-0000-4000-8000-000000000003',
  entry: UsageEntry.Plaza,
};

function setup() {
  const report = vi.fn();
  let owner: string | null = 'owner-a';
  let now = 10000;
  const messages: CoworkMessage[] = [];
  const tracker = new TaskUsageAnalytics({
    report,
    getOwner: () => owner,
    getSession: () => ({ agentId: 'local-agent', messages }),
    getAgent: () => ({ source: 'preset', presetId: 'official-expert' }),
    updateMessage: vi.fn(),
    now: () => now,
  });
  const send = (id: string, type: CoworkMessage['type'], metadata = {}, timestamp = now) => {
    const message = {
      id,
      type,
      timestamp,
      content: 'private prompt /file/path token=secret',
      metadata,
    };
    messages.push(message);
    tracker.message('local-session', message);
    return message;
  };
  return {
    tracker,
    report,
    send,
    messages,
    setOwner: (value: string | null) => {
      owner = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    events: () => report.mock.calls.map(call => call[0]),
  };
}

describe('TaskUsageAnalytics', () => {
  test('joins runtime outcomes to submission and counts a streamed tool result once', () => {
    const s = setup();
    expect(s.tracker.begin('local-session', { analytics: context }, false)).toBe(true);
    s.send('old-message', 'tool_use', { toolName: 'exec', toolUseId: 'old-tool' }, 1);
    s.send('user', 'user');
    s.send('use', 'tool_use', {
      toolName: 'private-server__private-tool',
      toolUseId: 'raw-tool-id',
      toolInput: { secret: 'private args' },
    });
    s.send('result', 'tool_result', { toolUseId: 'raw-tool-id', isStreaming: true });
    s.advance(300);
    s.tracker.update('local-session', 'result', {
      toolUseId: 'raw-tool-id',
      isStreaming: false,
      isError: true,
    });
    s.tracker.update('local-session', 'result', {
      toolUseId: 'raw-tool-id',
      isStreaming: false,
      isError: true,
    });
    s.tracker.end('local-session', UsageOutcome.Completed);
    s.tracker.end('local-session', UsageOutcome.Completed);
    const tools = s.events().filter(event => event.action === LogReporterAction.CapabilityUse);
    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      taskId: context.taskId,
      turnId: context.turnId,
      presetId: 'official-expert',
      capabilityKind: 'mcp',
      outcome: UsageOutcome.Failed,
      durationMs: 300,
    });
    expect(s.events().at(-1)).toMatchObject({
      outcome: UsageOutcome.CompletedWithToolErrors,
      toolCount: 1,
      toolErrorCount: 1,
    });
    const serialized = JSON.stringify(s.events());
    for (const privateValue of [
      'private prompt',
      'private args',
      '/file/path',
      'raw-tool-id',
      'local-session',
      'local-agent',
      'private-server',
      'owner-a',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test('a continuation reuses the persisted task id and creates a new turn id', () => {
    const s = setup();
    s.tracker.begin('local-session', { analytics: context }, false);
    s.send('user', 'user');
    s.tracker.end('local-session', UsageOutcome.Completed);
    s.tracker.begin('local-session', {}, true);
    expect(s.tracker.context('local-session')?.taskId).toBe(context.taskId);
    expect(s.tracker.context('local-session')?.turnId).not.toBe(context.turnId);
  });

  test('forked history cannot reuse its parent task identity', () => {
    const s = setup();
    s.tracker.begin('local-session', { analytics: context }, false);
    s.send('user', 'user');
    s.tracker.end('local-session', UsageOutcome.Completed);
    s.tracker.begin('fork-session', {}, true);
    expect(s.tracker.context('fork-session')?.taskId).not.toBe(context.taskId);
    expect(s.tracker.context('fork-session')?.journeyId).toBeUndefined();
  });

  test('final streamed metadata keeps the producing turn for history and artifact attribution', () => {
    const s = setup();
    s.tracker.begin('local-session', { analytics: context }, false);
    s.send('assistant', 'assistant', { isStreaming: true });
    const final: Record<string, unknown> = { isStreaming: false, isFinal: true };
    s.tracker.update('local-session', 'assistant', final);
    expect(final.usageAnalytics).toMatchObject({ turnId: context.turnId, localSessionId: 'local-session', ownerKey: 'owner-a' });
  });

  test('duplicate submission does not replace an active turn; timeout is not success', () => {
    const s = setup();
    s.tracker.begin('local-session', { analytics: context }, false);
    expect(s.tracker.begin('local-session', {}, false)).toBe(false);
    s.send('timeout', 'assistant', { isTimeout: true });
    s.tracker.end('local-session', UsageOutcome.Completed);
    expect(s.events().at(-1)).toMatchObject({
      turnId: context.turnId,
      outcome: UsageOutcome.Timeout,
      hadResponse: false,
    });
  });

  test('records permission dwell, a deny decision and cancellation without raw question content', () => {
    const s = setup();
    s.tracker.begin('local-session', {}, false);
    const request = {
      requestId: 'raw-request',
      toolName: 'private tool',
      toolInput: { text: 'private question' },
    };
    s.tracker.permission('local-session', request);
    s.tracker.permission('local-session', request);
    s.advance(1200);
    s.tracker.permissionResolved('local-session', request.requestId, 'deny');
    s.tracker.permissionResolved('local-session', request.requestId);
    s.tracker.permissionResolved('local-session', request.requestId);
    s.tracker.end('local-session', UsageOutcome.Cancelled);
    expect(s.events().filter(event => event.stage === UsageStage.Permission)).toHaveLength(2);
    expect(s.events().find(event => event.stage === UsageStage.PermissionDecision)).toMatchObject({
      outcome: UsageOutcome.Denied,
      durationMs: 1200,
    });
    expect(s.events().at(-1).outcome).toBe(UsageOutcome.Cancelled);
  });

  test.each([null, 'owner-b'])('drops in-flight attribution when owner changes to %s', owner => {
    const s = setup();
    s.tracker.begin('local-session', {}, false);
    const count = s.report.mock.calls.length;
    s.setOwner(owner);
    s.tracker.end('local-session', UsageOutcome.Completed);
    expect(s.report).toHaveBeenCalledTimes(count);
    expect(s.tracker.context('local-session')).toBeUndefined();
  });

  test('disabled analytics does not annotate messages or start tracking', () => {
    const s = setup();
    s.setOwner(null);
    expect(s.tracker.begin('local-session', {}, false)).toBe(false);
    const message = s.send('user', 'user');
    expect(message.metadata).toEqual({});
    expect(s.report).not.toHaveBeenCalled();
  });
});
