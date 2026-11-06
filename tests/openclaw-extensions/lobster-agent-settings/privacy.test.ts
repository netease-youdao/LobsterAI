import { expect, test } from 'vitest';

import { settingsTranscriptMessage } from '../../../openclaw-extensions/lobster-agent-settings/privacy';

test('settings transcript copies omit full input/output without mutating live tool data', () => {
  const message = { role: 'assistant', content: [{ type: 'toolCall', name: 'lobsterai_agent_settings', arguments: { action: 'update', section: 'memory', text: 'private memory', selection: { expectedText: 'private selection' } } }] };
  expect(JSON.stringify(settingsTranscriptMessage(message))).not.toContain('private');
  expect(message.content[0].arguments.text).toBe('private memory');
  const result = { role: 'toolResult', toolName: 'lobsterai_agent_settings', content: [{ type: 'text', text: 'private read' }], details: { text: 'private read' } };
  expect(JSON.stringify(settingsTranscriptMessage(result))).not.toContain('private');
  const ordinary = { ...result, toolName: 'read' }; expect(settingsTranscriptMessage(ordinary)).toBe(ordinary);
});
