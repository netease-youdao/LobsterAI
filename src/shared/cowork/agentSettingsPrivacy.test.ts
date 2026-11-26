import { describe, expect, it } from 'vitest';

import { AgentSettingsPrivateTool, sanitizeAgentSettingsHistory, sanitizeAgentSettingsToolEvent } from './agentSettingsPrivacy';

describe('Agent settings transcript privacy', () => {
  it('removes full input, selection proof, raw deltas and diffs before streaming persistence', () => {
    const event = sanitizeAgentSettingsToolEvent({ name: AgentSettingsPrivateTool, phase: 'input_delta', toolCallId: 'call',
      args: { action: 'update', section: 'memory', expectedRevision: 'revision-1', text: 'SECRET', selection: { expectedText: 'SECRET' } },
      delta: 'SECRET', input: 'SECRET', diff: { before: 'SECRET' }, futureField: { content: 'SECRET' } });
    expect(JSON.stringify(event)).not.toContain('SECRET');
    expect(event.args).toMatchObject({ action: 'update', section: 'memory', settingsContentOmitted: true });
    expect(event.diff).toBeUndefined();
  });
  it('keeps only bounded receipt fields from a live read result', () => {
    const event = sanitizeAgentSettingsToolEvent({ phase: 'result', toolCallId: 'call', result: {
      content: [{ type: 'text', text: JSON.stringify({ section: 'memory', revision: 'revision-1', value: { text: 'SECRET' }, text: 'SECRET', proposedDigest: 'SECRET' }) }],
      details: { private: 'SECRET' },
    } });
    expect(JSON.stringify(event)).not.toContain('SECRET'); expect(JSON.stringify(event)).toContain('revision-1');
  });
  it('redacts history results without a tool name using their associated tool call id', () => {
    const history = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: AgentSettingsPrivateTool,
      arguments: { action: 'update', section: 'identity', text: 'SECRET', selection: { expectedText: 'SECRET' } } }] },
    { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: '{"section":"identity","value":{"text":"SECRET"}}' }], details: 'SECRET' }];
    const safe = sanitizeAgentSettingsHistory(history);
    expect(JSON.stringify(safe)).not.toContain('SECRET'); expect(JSON.stringify(history)).toContain('SECRET');
  });
  it('uses durable tool ids when the bounded history window no longer contains the call', () => {
    const safe = sanitizeAgentSettingsHistory([{ role: 'tool_result', tool_call_id: 'call', content: 'SECRET' }], new Set(['call']));
    expect(JSON.stringify(safe)).not.toContain('SECRET');
  });
  it('leaves unrelated tools and ordinary conversation unchanged', () => {
    const history = [{ role: 'user', content: 'ordinary text' }, { role: 'toolResult', toolName: 'read', toolCallId: 'file', content: 'ordinary file content' }];
    expect(sanitizeAgentSettingsHistory(history)).toEqual(history);
  });
});
