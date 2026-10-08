import { describe, expect, test } from 'vitest';

import { AgentLifecyclePhase } from '../constants';
import {
  getCurrentRunYieldToolCallId,
  isSuccessfulYieldResult,
  isYieldedLifecycle,
  SubagentYield,
  YieldHistoryRole,
  YieldHistoryToolCallType,
} from './yield';

const STARTED_AT = Date.parse('2026-09-12T18:40:00.000Z');
const YIELD_RESULT = JSON.stringify({ status: SubagentYield.ResultStatus, message: 'Waiting for child tasks.' });
const lifecycle = {
  phase: AgentLifecyclePhase.End,
  yielded: true,
  livenessState: SubagentYield.LivenessState,
  stopReason: SubagentYield.StopReason,
};

const toolCall = (id: string, name: string = SubagentYield.ToolName, timestamp: unknown = STARTED_AT) => ({
  role: YieldHistoryRole.Assistant,
  timestamp,
  content: [{ type: YieldHistoryToolCallType.ToolCall, id, name }],
});

const toolResult = (id: string, timestamp: unknown = STARTED_AT + 1) => ({
  role: YieldHistoryRole.ToolResult,
  toolCallId: id,
  timestamp,
  content: YIELD_RESULT,
});

describe('yield lifecycle classification', () => {
  test('accepts only a normal yielded parent lifecycle', () => {
    expect(isYieldedLifecycle(lifecycle)).toBe(true);
    expect(isYieldedLifecycle({ ...lifecycle, aborted: false, error: null })).toBe(true);
  });

  test.each([
    null,
    [],
    {},
    { ...lifecycle, phase: AgentLifecyclePhase.Error },
    { ...lifecycle, yielded: false },
    { ...lifecycle, livenessState: undefined },
    { ...lifecycle, stopReason: undefined },
    { ...lifecycle, aborted: true },
    { ...lifecycle, status: SubagentYield.CancelledStatus },
    { ...lifecycle, status: SubagentYield.TimedOutStatus },
    { ...lifecycle, timeoutPhase: 'provider' },
    { ...lifecycle, error: 'provider failed' },
  ])('does not suppress terminal failures or incomplete evidence: %j', (data) => {
    expect(isYieldedLifecycle(data)).toBe(false);
  });
});

describe('successful yield result classification', () => {
  test('requires the tool name and structured successful status', () => {
    expect(isSuccessfulYieldResult(SubagentYield.ToolName, YIELD_RESULT)).toBe(true);
    expect(isSuccessfulYieldResult('sessions_spawn', YIELD_RESULT)).toBe(false);
    expect(isSuccessfulYieldResult(SubagentYield.ToolName, YIELD_RESULT, true)).toBe(false);
  });

  test.each([
    '',
    'Turn yielded.',
    'null',
    '[]',
    '{"status":"error","error":"No pending child completion"}',
    JSON.stringify({ status: SubagentYield.ResultStatus, error: 'failed to persist' }),
  ])('rejects missing or failed yield evidence: %s', (text) => {
    expect(isSuccessfulYieldResult(SubagentYield.ToolName, text)).toBe(false);
  });
});

describe('current run yield history recovery', () => {
  test('matches a timestamped call and successful result with legacy identifiers', () => {
    const call = {
      role: YieldHistoryRole.Assistant,
      createdAt: new Date(STARTED_AT).toISOString(),
      content: [{ type: YieldHistoryToolCallType.ToolUse, tool_use_id: 'yield-1', tool_name: SubagentYield.ToolName }],
    };
    const result = {
      role: YieldHistoryRole.ToolResult,
      tool_use_id: 'yield-1',
      created_at: String(STARTED_AT + 1),
      content: [{ type: 'text', text: YIELD_RESULT }],
    };
    expect(getCurrentRunYieldToolCallId([call, result], STARTED_AT)).toBe('yield-1');
  });

  test('accepts a named current result when compacted history omitted its call', () => {
    expect(getCurrentRunYieldToolCallId([
      { ...toolResult('yield-1'), toolName: SubagentYield.ToolName },
    ], STARTED_AT)).toBe('yield-1');
    expect(getCurrentRunYieldToolCallId([toolResult('yield-1')], STARTED_AT)).toBeUndefined();
  });

  test('does not reuse a previous run yield during announce continuation', () => {
    const history = [toolCall('yield-1'), toolResult('yield-1')];
    expect(getCurrentRunYieldToolCallId(history, STARTED_AT + 2)).toBeUndefined();
    expect(getCurrentRunYieldToolCallId([
      toolCall('yield-1', SubagentYield.ToolName, STARTED_AT - 1), toolResult('yield-1'),
    ], STARTED_AT)).toBeUndefined();
  });

  test.each([undefined, null, 'not a date', 0, NaN])('requires a verifiable timestamp: %j', (timestamp) => {
    expect(getCurrentRunYieldToolCallId([
      { ...toolCall('yield-1'), timestamp }, toolResult('yield-1'),
    ], STARTED_AT)).toBeUndefined();
    expect(getCurrentRunYieldToolCallId([
      toolCall('yield-1'), { ...toolResult('yield-1'), timestamp },
    ], STARTED_AT)).toBeUndefined();
  });

  test('later tool work invalidates the earlier yield even when not a backfillable tool', () => {
    const history = [toolCall('yield-1'), toolResult('yield-1')];
    expect(getCurrentRunYieldToolCallId([
      ...history, toolCall('exec-1', 'exec', STARTED_AT + 2),
    ], STARTED_AT)).toBeUndefined();
    expect(getCurrentRunYieldToolCallId([
      ...history, toolCall('exec-1', 'exec', STARTED_AT + 2), toolResult('exec-1', STARTED_AT + 3),
    ], STARTED_AT)).toBeUndefined();
    expect(getCurrentRunYieldToolCallId([
      ...history, { ...toolResult('exec-1', STARTED_AT + 3), toolName: 'exec' },
    ], STARTED_AT)).toBeUndefined();
  });

  test('a later assistant or user segment retires the handoff', () => {
    const history = [toolCall('yield-1'), toolResult('yield-1')];
    for (const role of [YieldHistoryRole.Assistant, YieldHistoryRole.User]) {
      expect(getCurrentRunYieldToolCallId([
        ...history, { role, timestamp: STARTED_AT + 2, content: [] },
      ], STARTED_AT)).toBeUndefined();
    }
  });

  test('does not accept failed, mismatched, or later non-yield calls', () => {
    for (const result of [
      { ...toolResult('yield-1'), isError: true },
      { ...toolResult('yield-1'), is_error: true },
      { ...toolResult('yield-1'), error: 'failed' },
      { ...toolResult('yield-1'), toolName: 'exec' },
      toolResult('other-call'),
    ]) {
      expect(getCurrentRunYieldToolCallId([toolCall('yield-1'), result], STARTED_AT)).toBeUndefined();
    }
    const call = toolCall('yield-1');
    call.content.push({ type: YieldHistoryToolCallType.ToolCall, id: 'exec-1', name: 'exec' });
    expect(getCurrentRunYieldToolCallId([call, toolResult('yield-1')], STARTED_AT)).toBeUndefined();
  });

  test('can identify a second successful yield after resumed tool work', () => {
    expect(getCurrentRunYieldToolCallId([
      toolCall('yield-1'), toolResult('yield-1'),
      toolCall('exec-1', 'exec', STARTED_AT + 2),
      toolCall('yield-2', SubagentYield.ToolName, STARTED_AT + 3),
      toolResult('yield-2', STARTED_AT + 4),
    ], STARTED_AT)).toBe('yield-2');
  });
});
