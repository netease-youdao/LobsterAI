import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../../coworkStore';
import {
  buildSubagentChildHistorySyncPlan,
  normalizeSubagentVisibleUserText,
} from './childHistorySync';

describe('subagent child history sync', () => {
  test('normalizes outbound subagent prompts to the visible user request', () => {
    const rawOutboundPrompt = `[LobsterAI system instructions]
hidden setup

[Context bridge from previous LobsterAI conversation]
previous context

[Current user request]
rewrite the intro`;

    expect(normalizeSubagentVisibleUserText(rawOutboundPrompt)).toBe('rewrite the intro');
  });

  test('preserves visible local user text instead of raw outbound prompt', () => {
    const rawOutboundPrompt = `[LobsterAI system instructions]
hidden setup

[Current user request]
rewrite the intro`;
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: rawOutboundPrompt, timestamp: 1, metadata: {} },
      { id: 'msg-2', type: 'assistant', content: 'new intro', timestamp: 2, metadata: {} },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: rawOutboundPrompt, timestamp: 10 },
      { role: 'assistant', content: 'new intro', timestamp: 20 },
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.cursor).toBe(2);
    expect(plan.entriesToStore).toEqual([
      { type: 'user', content: 'rewrite the intro', timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'new intro',
        timestamp: 20,
        metadata: { isStreaming: false, isFinal: true },
      },
    ]);
  });

  test('includes subagent tool calls and results in child session history', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'run tests', timestamp: 1, metadata: {} },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      { role: 'user', content: 'run tests' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run the tests.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'Bash',
            arguments: { command: 'npm test' },
          },
        ],
      },
      {
        role: 'tool_result',
        tool_use_id: 'call-1',
        content: '24 tests passed',
      },
      { role: 'assistant', content: 'All tests passed.' },
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.entriesToStore).toEqual([
      { type: 'user', content: 'run tests', timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'I will run the tests.',
        timestamp: expect.any(Number),
        metadata: { isStreaming: false, isFinal: true },
      },
      {
        type: 'tool_use',
        content: '',
        timestamp: expect.any(Number),
        metadata: {
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
          toolUseId: 'call-1',
        },
      },
      {
        type: 'tool_result',
        content: '24 tests passed',
        timestamp: expect.any(Number),
        metadata: {
          toolName: undefined,
          toolResult: '24 tests passed',
          toolUseId: 'call-1',
        },
      },
      {
        type: 'assistant',
        content: 'All tests passed.',
        timestamp: expect.any(Number),
        metadata: { isStreaming: false, isFinal: true },
      },
    ]);
  });
});
