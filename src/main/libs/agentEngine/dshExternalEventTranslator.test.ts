import { describe, expect, test } from 'vitest';

import { AgentId } from '../../../shared/agent/constants';
import { CoworkSessionSource } from '../../../shared/cowork/constants';
import {
  buildExternalDshMessageId,
  deriveExternalSessionTitle,
  deriveExternalTurnTraceId,
  DshDurableEventType,
  DshExternalMessagePartKind,
  isEligibleExternalDshSummary,
  resolveAgentIdForExternalCwd,
  translateDshDurableEvent,
} from './dshExternalEventTranslator';

describe('dshExternalEventTranslator', () => {
  test('buildExternalDshMessageId is deterministic, UUID-shaped, and varies by session/seq/part', () => {
    const id1 = buildExternalDshMessageId('sess-1', 4, DshExternalMessagePartKind.User);
    const id2 = buildExternalDshMessageId('sess-1', 4, DshExternalMessagePartKind.User);
    const id3 = buildExternalDshMessageId('sess-1', 4, DshExternalMessagePartKind.Assistant);
    const id4 = buildExternalDshMessageId('sess-1', 5, DshExternalMessagePartKind.User);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id1).not.toBe(id3);
    expect(id1).not.toBe(id4);
  });

  test('translates genuine user/message events and ignores goal/subagent/non-append events', () => {
    const userRes = translateDshDurableEvent('sess-a', {
      seq: 2,
      type: DshDurableEventType.UserMessage,
      time: 1700000002000,
      surfaceOp: 'append',
      data: {
        source: { kind: 'user', rpcId: 'rpc-42' },
        message: {
          content: [
            { type: 'text', text: 'Check this screenshot' },
            { type: 'image', attachmentId: 'att-1', mediaType: 'image/png', name: 'snap.png' },
            { type: 'file', path: '/tmp/report.pdf', name: 'report.pdf' },
          ],
        },
      },
    });

    expect(userRes.kind).toBe('messages');
    if (userRes.kind !== 'messages') throw new Error('Expected messages');
    expect(userRes.messages).toHaveLength(1);
    const msg = userRes.messages[0];
    expect(msg.type).toBe('user');
    expect(msg.content).toBe('Check this screenshot');
    expect(msg.rpcId).toBe('rpc-42');
    expect(msg.timestamp).toBe(1700000002000);
    expect(msg.imageRefs).toHaveLength(1);
    expect(msg.imageRefs?.[0]).toMatchObject({
      attachmentId: 'att-1',
      mediaType: 'image/png',
      name: 'snap.png',
    });
    expect(msg.metadata).toMatchObject({
      seq: 2,
      dshSessionId: 'sess-a',
      externalSource: CoworkSessionSource.DshExternal,
      llmTrace: {
        traceId: deriveExternalTurnTraceId('sess-a', 2),
        startedAt: 1700000002000,
      },
      dshRpcId: 'rpc-42',
      filePaths: ['/tmp/report.pdf'],
    });

    // Goal-loop synthetic user prompts are ignored.
    const goalRes = translateDshDurableEvent('sess-a', {
      seq: 3,
      type: DshDurableEventType.UserMessage,
      data: {
        source: { kind: 'goal', round: 2 },
        message: { content: [{ type: 'text', text: 'Continue goal' }] },
      },
    });
    expect(goalRes).toEqual({ kind: 'ignore', seq: 3 });

    // Non-append replacement records are ignored.
    const replaceRes = translateDshDurableEvent('sess-a', {
      seq: 4,
      type: DshDurableEventType.UserMessage,
      surfaceOp: 'replace',
      data: {
        source: { kind: 'user' },
        message: { content: [{ type: 'text', text: 'Compacted' }] },
      },
    });
    expect(replaceRes).toEqual({ kind: 'ignore', seq: 4 });
  });

  test('translates assistant/message with both reasoning and text into separate deterministic parts', () => {
    const res = translateDshDurableEvent('sess-b', {
      seq: 7,
      type: DshDurableEventType.AssistantMessage,
      time: 1700000007000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'Step 1: inspect files.' },
            { type: 'text', text: 'Here is the summary.' },
          ],
        },
      },
    });

    expect(res.kind).toBe('messages');
    if (res.kind !== 'messages') throw new Error('Expected messages');
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({
      id: buildExternalDshMessageId('sess-b', 7, DshExternalMessagePartKind.Thinking),
      type: 'assistant',
      content: 'Step 1: inspect files.',
      metadata: expect.objectContaining({ isThinking: true, isStreaming: false, seq: 7 }),
    });
    expect(res.messages[1]).toMatchObject({
      id: buildExternalDshMessageId('sess-b', 7, DshExternalMessagePartKind.Assistant),
      type: 'assistant',
      content: 'Here is the summary.',
      metadata: expect.objectContaining({ isStreaming: false, seq: 7 }),
    });
  });

  test('translates tool/call, tool/result, session/title, and turn/end events', () => {
    const callRes = translateDshDurableEvent('sess-c', {
      seq: 10,
      type: DshDurableEventType.ToolCall,
      data: { callId: 'c-1', name: 'read_file', arguments: '{"path":"README.md"}' },
    });
    expect(callRes.kind).toBe('messages');
    if (callRes.kind !== 'messages') throw new Error('Expected messages');
    expect(callRes.messages[0]).toMatchObject({
      type: 'tool_use',
      content: 'read_file',
      metadata: expect.objectContaining({
        toolUseId: 'c-1',
        toolName: 'read_file',
        toolInput: { path: 'README.md' },
      }),
    });

    const resultRes = translateDshDurableEvent('sess-c', {
      seq: 11,
      type: DshDurableEventType.ToolResult,
      data: {
        message: { callId: 'c-1', content: [{ type: 'text', text: 'file contents' }], isError: false },
      },
    });
    expect(resultRes.kind).toBe('messages');
    if (resultRes.kind !== 'messages') throw new Error('Expected messages');
    expect(resultRes.messages[0]).toMatchObject({
      type: 'tool_result',
      content: 'file contents',
      metadata: expect.objectContaining({ toolUseId: 'c-1', isError: false }),
    });

    expect(
      translateDshDurableEvent('sess-c', {
        seq: 12,
        type: DshDurableEventType.SessionTitle,
        data: { title: 'Pocket Debug Session' },
      }),
    ).toEqual({ kind: 'title', seq: 12, title: 'Pocket Debug Session' });

    expect(
      translateDshDurableEvent('sess-c', {
        seq: 13,
        type: DshDurableEventType.TurnEnd,
        data: { reason: { kind: 'error', error: { message: 'Model rate limited' } } },
      }),
    ).toEqual({ kind: 'turnEnd', seq: 13, error: 'Model rate limited', aborted: false });

    expect(
      translateDshDurableEvent('sess-c', {
        seq: 14,
        type: DshDurableEventType.TurnEnd,
        data: { reason: { kind: 'aborted' } },
      }),
    ).toEqual({ kind: 'turnEnd', seq: 14, error: null, aborted: true });
  });

  test('deriveExternalSessionTitle prefers projection title, then event title, then first user message, then fallback', () => {
    const events = [
      translateDshDurableEvent('s', {
        seq: 1,
        type: DshDurableEventType.UserMessage,
        data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'First prompt text' }] } },
      }),
    ];

    expect(
      deriveExternalSessionTitle({
        summary: { sessionId: 's', projections: { values: { title: 'Projected Title' } } },
        translatedEvents: events,
        fallbackTitle: 'DSH Session',
      }),
    ).toBe('Projected Title');

    expect(
      deriveExternalSessionTitle({
        summary: { sessionId: 's' },
        translatedEvents: events,
        fallbackTitle: 'DSH Session',
      }),
    ).toBe('First prompt text');

    expect(
      deriveExternalSessionTitle({
        summary: { sessionId: 's' },
        translatedEvents: [],
        fallbackTitle: 'DSH Session',
      }),
    ).toBe('DSH Session');
  });

  test('resolveAgentIdForExternalCwd matches deepest enabled agent directory or falls back to main', () => {
    const agents = [
      { id: AgentId.Main, workingDirectory: '/work', enabled: true },
      { id: 'research', workingDirectory: '/work/research', enabled: true },
      { id: 'disabled-agent', workingDirectory: '/work/research/deep', enabled: false },
    ];

    expect(resolveAgentIdForExternalCwd('/work/research/deep/notes', agents, 'darwin')).toBe('research');
    expect(resolveAgentIdForExternalCwd('/work', agents, 'darwin')).toBe(AgentId.Main);
    expect(resolveAgentIdForExternalCwd('/other/path', agents, 'darwin')).toBe(AgentId.Main);
    expect(resolveAgentIdForExternalCwd(undefined, agents, 'darwin')).toBe(AgentId.Main);
  });

  test('isEligibleExternalDshSummary filters out subagents and invalid entries', () => {
    expect(isEligibleExternalDshSummary({ sessionId: 'top-1' })).toBe(true);
    expect(isEligibleExternalDshSummary({ sessionId: 'sub-1', origin: 'subagent' })).toBe(false);
    expect(isEligibleExternalDshSummary({ sessionId: 'sub-2', parentSessionId: 'top-1' })).toBe(false);
    expect(isEligibleExternalDshSummary({ sessionId: '' })).toBe(false);
    expect(isEligibleExternalDshSummary(null)).toBe(false);
  });
});
