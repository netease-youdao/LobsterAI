import { describe, expect, test } from 'vitest';

import { extractCurrentTurnThinkingBlocks } from './blocks';

describe('OpenClaw thinking block extraction', () => {
  test('preserves assistant and content order while anchoring blocks to tools', () => {
    const result = extractCurrentTurnThinkingBlocks([
      { role: 'user', content: 'old turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'old thought' },
          { type: 'toolCall', id: 'old-tool', name: 'read' },
        ],
      },
      { role: 'user', content: 'new turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect the source' },
          { type: 'toolCall', id: 'tool-1', name: 'read' },
        ],
      },
      { role: 'toolResult', toolCallId: 'tool-1', content: 'source' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'run the tests' },
          { type: 'toolCall', id: 'tool-2', name: 'exec' },
        ],
      },
      { role: 'toolResult', toolCallId: 'tool-2', content: 'ok' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'summarize the result' },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        key: 'tool:tool-1:thinking:0',
        text: 'inspect the source',
        assistantOrdinal: 0,
        contentIndex: 0,
        anchorToolCallId: 'tool-1',
      },
      {
        key: 'tool:tool-2:thinking:0',
        text: 'run the tests',
        assistantOrdinal: 1,
        contentIndex: 0,
        anchorToolCallId: 'tool-2',
      },
      expect.objectContaining({
        key: expect.stringMatching(/^final:thinking:/),
        text: 'summarize the result',
        assistantOrdinal: 2,
        contentIndex: 0,
      }),
    ]);
  });

  test('keeps multiple thinking blocks within one assistant message separate', () => {
    const result = extractCurrentTurnThinkingBlocks([
      { role: 'user', content: 'work' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first' },
          { type: 'thinking', thinking: 'second' },
          { type: 'tool_call', tool_call_id: 'tool-a' },
        ],
      },
    ]);

    expect(result.map((block) => ({ key: block.key, text: block.text }))).toEqual([
      { key: 'tool:tool-a:thinking:0', text: 'first' },
      { key: 'tool:tool-a:thinking:1', text: 'second' },
    ]);
  });

  test('supports reasoning fields when structured thinking blocks are unavailable', () => {
    const result = extractCurrentTurnThinkingBlocks([
      { role: 'assistant', reasoning_content: 'provider reasoning' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'provider reasoning',
      assistantOrdinal: 0,
      contentIndex: -1,
    });
  });

  test('creates distinct deterministic keys for repeated final thinking text', () => {
    const history = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'same' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'same' }] },
    ];

    const first = extractCurrentTurnThinkingBlocks(history);
    const second = extractCurrentTurnThinkingBlocks(history);

    expect(first.map((block) => block.key)).toEqual(second.map((block) => block.key));
    expect(first[0].key).not.toBe(first[1].key);
  });
});
