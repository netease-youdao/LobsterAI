import { expect, test, vi } from 'vitest';

import type { CoworkMessage } from '../../coworkStore';
import type { DshCoworkStorePort } from '../agentEngine/dshRuntimeAdapter';
import { applyDshTranscriptPage } from './dshRemoteTranscript';

test('recovery completes the existing assistant bubble and replays a missing tool result exactly once', () => {
  const messages: CoworkMessage[] = [
    { id: 'user', type: 'user', content: 'prompt', timestamp: 1, metadata: { requestId: 'a' } },
    { id: 'partial', type: 'assistant', content: 'par', timestamp: 2, metadata: { isStreaming: true } },
  ];
  const store: DshCoworkStorePort = {
    getSession: () => ({ id: 's', cwd: '/project', messages }),
    updateMessageContent: (_session, id, content, metadata) => Object.assign(messages.find(row => row.id === id)!, { content, metadata }),
    addMessage: (_session, data) => {
      const message = { ...data, id: String(messages.length), timestamp: 3 };
      messages.push(message);
      return message;
    },
    updateSession: vi.fn(),
  };
  const page = [{ type: 'assistant/message', seq: 4, data: { content: 'partial completed' } },
    { type: 'tool/result', seq: 5, data: { callId: 'call', content: 'tool output' } }];
  const changed = vi.fn();
  applyDshTranscriptPage(store, 's', 'dsh:native', 'a', page, changed);
  applyDshTranscriptPage(store, 's', 'dsh:native', 'a', page, changed);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(messages.slice(1).map(row => [row.id, row.content, row.metadata?.seq])).toEqual([
    ['partial', 'partial completed', 4], ['2', 'tool output', 5],
  ]);
  expect(() => applyDshTranscriptPage(store, 's', 'dsh:native', 'other', page, changed)).toThrow();
});

test('settings result text and native presentation metadata never reach the chat, including across pages', () => {
  const messages: CoworkMessage[] = [{ id: 'u', type: 'user', content: 'prompt', timestamp: 1, metadata: { requestId: 'r' } }];
  const store: DshCoworkStorePort = {
    getSession: () => ({ id: 's', cwd: '/project', messages }),
    addMessage: (_id, input) => { const msg = { ...input, id: String(messages.length), timestamp: 2 }; messages.push(msg); return msg; },
    updateMessageContent: vi.fn(), updateSession: vi.fn(),
  };
  const call = { type: 'tool/call', seq: 2, data: { name: 'lobsterai_agent_settings', callId: 'c',
    arguments: JSON.stringify({ action: 'read', section: 'memory', selection: 'not-for-chat' }) } };
  applyDshTranscriptPage(store, 's', 'dsh:n', 'r', [call], vi.fn());
  const result = { type: 'tool/result', seq: 3, data: { callId: 'c', content: JSON.stringify({ section: 'memory', body: 'not-for-chat' }),
    meta: { lobsterToolResult: { details: { secret: 'not-for-chat' } } } } };
  applyDshTranscriptPage(store, 's', 'dsh:n', 'r', [result], vi.fn());
  expect(JSON.stringify(messages)).not.toContain('not-for-chat');
  expect(messages.at(-1)?.content).toContain('settingsContentOmitted');
});
