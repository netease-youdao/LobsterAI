import { EventEmitter } from 'events';
import { expect, test, vi } from 'vitest';

import { CoworkTurnOutcome } from '../../shared/cowork/turnOutcome';
import type { CoworkMessage, CoworkStore } from '../coworkStore';
import type { CoworkEngineRouter } from '../libs/agentEngine/coworkEngineRouter';
import { bindCoworkTurnOutcomes } from './turnOutcomes';

function fixture() {
  const runtime = new EventEmitter();
  const user: CoworkMessage = { id: 'user', type: 'user', content: 'question', timestamp: 1, metadata: { model: 'model' } };
  const reply: CoworkMessage = { id: 'reply', type: 'assistant', content: 'answer', timestamp: 2 };
  const session = { status: CoworkTurnOutcome.Completed as string, messages: [reply] };
  const store = {
    getLatestUserMessage: () => user,
    getSession: () => session,
    updateMessage: vi.fn((_sessionId: string, messageId: string, update: { metadata: Record<string, unknown> }) => {
      (messageId === user.id ? user : reply).metadata = update.metadata;
    }),
  };
  bindCoworkTurnOutcomes(runtime as CoworkEngineRouter, store as unknown as CoworkStore);
  const update = vi.fn();
  runtime.on('messageUpdate', update);
  return { runtime, user, reply, session, store, update };
}

test('saves successful outcomes on both the user anchor and paged terminal reply, preserving metadata', () => {
  const f = fixture();
  f.runtime.emit('complete', 'session');
  expect(f.user.metadata).toMatchObject({ turnOutcome: CoworkTurnOutcome.Completed, model: 'model' });
  expect(f.reply.metadata?.turnOutcome).toBe(CoworkTurnOutcome.Completed);
  expect(f.update).toHaveBeenCalledWith('session', f.user.id, f.user.content, expect.objectContaining({ isFinal: true }));
});

test.each([
  ['sessionStopped', CoworkTurnOutcome.Stopped],
  ['error', CoworkTurnOutcome.Failed],
])('%s survives a subsequent change of session status', (event, outcome) => {
  const f = fixture();
  f.runtime.emit(event, 'session');
  f.session.status = CoworkTurnOutcome.Completed;
  expect(f.user.metadata?.turnOutcome).toBe(outcome);
  expect(f.reply.metadata?.turnOutcome).toBe(outcome);
});

test('a complete notification alone never labels a safety abort as successful', () => {
  const f = fixture();
  f.session.status = 'idle';
  f.runtime.emit('complete', 'session');
  expect(f.user.metadata?.turnOutcome).toBe(CoworkTurnOutcome.Stopped);
});
