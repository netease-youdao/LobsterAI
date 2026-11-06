import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../../../coworkStore';
import { buildOpenClawLocalTimeContextPrompt } from '../../openclawLocalTimeContextPrompt';
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

  test('preserves existing local user content verbatim during history recovery', () => {
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
      { type: 'user', content: rawOutboundPrompt, timestamp: 1, metadata: {} },
      {
        type: 'assistant',
        content: 'new intro',
        timestamp: 20,
        metadata: { isStreaming: false, isFinal: true },
      },
    ]);
  });

  test('keeps the seeded spawn task as the first turn when the gateway wraps it', () => {
    const localMessages: CoworkMessage[] = [
      { id: 'msg-1', type: 'user', content: 'Publish the article.', timestamp: 1 },
    ] as CoworkMessage[];

    const plan = buildSubagentChildHistorySyncPlan(localMessages, [
      {
        role: 'user',
        content: '[Subagent Context] You are running as a subagent (depth 1/1).\n\n'
          + '[Subagent Task]\n\nPublish the article.\n\nBegin. Execute the assigned task to completion.\n',
        timestamp: 10,
      },
      { role: 'assistant', content: 'Published.', timestamp: 20 },
    ]);

    expect(plan.entriesToStore.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'Publish the article.' },
      { type: 'assistant', content: 'Published.' },
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


test('restores user body without generated time footer and leaves source history unchanged', () => {
  const footer = buildOpenClawLocalTimeContextPrompt(new Date('2026-10-27T01:00:00Z'));
  for (const tail of [footer, footer.split('\n').slice(1, -1).join('\n')]) {
    const history = [{
      role: 'user', content: `[Current user request]\nremind me tomorrow\n\n${tail}`, timestamp: 100,
    }];
    const before = JSON.stringify(history);
    const plan = buildSubagentChildHistorySyncPlan([], history);
    expect(plan.entriesToStore[0].content).toBe('remind me tomorrow');
    expect(JSON.stringify(history)).toBe(before);

    const local = [{ id: 'old', type: 'user', content: history[0].content, timestamp: 7 }] as CoworkMessage[];
    const localBefore = JSON.stringify(local);
    const restored = buildSubagentChildHistorySyncPlan(local, history);
    expect(restored.changed).toBe(false);
    expect(restored.entriesToStore[0]).toMatchObject({ content: local[0].content, timestamp: 7 });
    expect(JSON.stringify(local)).toBe(localBefore);
  }
});
