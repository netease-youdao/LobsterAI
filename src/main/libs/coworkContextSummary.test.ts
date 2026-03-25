import { test, expect, describe } from 'vitest';
import { generateRuleBasedSummary } from './coworkContextSummary';

interface TestMessage {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function makeMessages(turns: Array<{ user: string; assistant: string; toolNames?: string[]; files?: string[] }>): TestMessage[] {
  const messages: TestMessage[] = [];
  for (const turn of turns) {
    messages.push({ type: 'user', content: turn.user });
    if (turn.toolNames) {
      for (const toolName of turn.toolNames) {
        messages.push({
          type: 'tool_use',
          content: `Tool: ${toolName}`,
          metadata: { toolName },
        });
      }
    }
    if (turn.files) {
      for (const file of turn.files) {
        messages.push({
          type: 'tool_use',
          content: `Edit file: ${file}`,
          metadata: { toolName: 'edit_file', toolInput: { file_path: file } },
        });
      }
    }
    messages.push({ type: 'assistant', content: turn.assistant });
  }
  return messages;
}

describe('generateRuleBasedSummary', () => {
  test('returns empty string for no turns to summarize', () => {
    const result = generateRuleBasedSummary([], 0);
    expect(result).toBe('');
  });

  test('summarizes a single turn', () => {
    const messages = makeMessages([
      { user: 'Fix the login bug', assistant: 'I found and fixed the login bug in auth.ts' },
    ]);
    const result = generateRuleBasedSummary(messages, 1);
    expect(result).toContain('Turn 1');
    expect(result).toContain('Fix the login bug');
    expect(result).toContain('found and fixed the login bug');
  });

  test('includes tool names in summary', () => {
    const messages = makeMessages([
      {
        user: 'Read the config file',
        assistant: 'I read the file and found the issue',
        toolNames: ['read_file', 'search'],
      },
    ]);
    const result = generateRuleBasedSummary(messages, 1);
    expect(result).toContain('Tools:');
    expect(result).toContain('read_file');
    expect(result).toContain('search');
  });

  test('includes modified files in summary', () => {
    const messages = makeMessages([
      {
        user: 'Update the component',
        assistant: 'Updated the component with the new prop',
        files: ['src/components/App.tsx', 'src/utils/helpers.ts'],
      },
    ]);
    const result = generateRuleBasedSummary(messages, 1);
    expect(result).toContain('Modified:');
    expect(result).toContain('src/components/App.tsx');
    expect(result).toContain('src/utils/helpers.ts');
  });

  test('summarizes multiple turns', () => {
    const messages = makeMessages([
      { user: 'First task', assistant: 'Done first' },
      { user: 'Second task', assistant: 'Done second' },
      { user: 'Third task', assistant: 'Done third' },
    ]);
    const result = generateRuleBasedSummary(messages, 3);
    expect(result).toContain('Turn 1');
    expect(result).toContain('Turn 2');
    expect(result).toContain('Turn 3');
    expect(result).toContain('First task');
    expect(result).toContain('Second task');
    expect(result).toContain('Third task');
  });

  test('only summarizes turns up to upToTurn', () => {
    const messages = makeMessages([
      { user: 'First task', assistant: 'Done first' },
      { user: 'Second task', assistant: 'Done second' },
      { user: 'Third task', assistant: 'Done third' },
    ]);
    const result = generateRuleBasedSummary(messages, 2);
    expect(result).toContain('Turn 1');
    expect(result).toContain('Turn 2');
    expect(result).not.toContain('Turn 3');
    expect(result).not.toContain('Third task');
  });

  test('truncates user excerpt at 200 chars', () => {
    const longText = 'A'.repeat(300);
    const messages = makeMessages([
      { user: longText, assistant: 'Done' },
    ]);
    const result = generateRuleBasedSummary(messages, 1);
    // Should contain truncated text ending with ...
    expect(result).toContain('...');
    // Should not contain the full 300-char text
    expect(result).not.toContain(longText);
  });

  test('respects maxChars limit', () => {
    const messages = makeMessages(
      Array.from({ length: 20 }, (_, i) => ({
        user: `Task number ${i + 1} with some description text`,
        assistant: `Completed task ${i + 1} with detailed explanation of what was done`,
      }))
    );
    const result = generateRuleBasedSummary(messages, 20, 500);
    expect(result.length).toBeLessThanOrEqual(600); // Allow for the "... more turns omitted" suffix
    expect(result).toContain('more turns omitted');
  });

  test('handles messages with no user message in a turn', () => {
    const messages: TestMessage[] = [
      { type: 'assistant', content: 'System initialized' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there' },
    ];
    const result = generateRuleBasedSummary(messages, 2);
    expect(result).toContain('Turn 1');
  });

  test('filters out thinking messages from assistant excerpts', () => {
    const messages: TestMessage[] = [
      { type: 'user', content: 'Do something' },
      { type: 'assistant', content: 'Let me think about this...', metadata: { isThinking: true } },
      { type: 'assistant', content: 'Here is the actual response' },
    ];
    const result = generateRuleBasedSummary(messages, 1);
    expect(result).toContain('actual response');
    expect(result).not.toContain('Let me think');
  });
});
