import test from 'node:test';
import assert from 'node:assert/strict';

import {
  removeSessionFromState,
  removeSessionsFromState,
} from '../src/renderer/store/slices/coworkDeleteState.ts';

test('removeSessionFromState clears streaming when deleting the current session', () => {
  const state = {
    sessions: [{ id: 's1' }, { id: 's2' }],
    unreadSessionIds: ['s1', 's2'],
    currentSessionId: 's1',
    currentSession: { id: 's1' },
    isStreaming: true,
  };

  removeSessionFromState(state, 's1');

  assert.equal(state.currentSessionId, null);
  assert.equal(state.currentSession, null);
  assert.equal(state.isStreaming, false);
  assert.deepEqual(state.sessions, [{ id: 's2' }]);
  assert.deepEqual(state.unreadSessionIds, ['s2']);
});

test('removeSessionFromState keeps streaming when deleting a non-current session', () => {
  const state = {
    sessions: [{ id: 's1' }, { id: 's2' }],
    unreadSessionIds: ['s2'],
    currentSessionId: 's1',
    currentSession: { id: 's1' },
    isStreaming: true,
  };

  removeSessionFromState(state, 's2');

  assert.equal(state.currentSessionId, 's1');
  assert.deepEqual(state.currentSession, { id: 's1' });
  assert.equal(state.isStreaming, true);
  assert.deepEqual(state.sessions, [{ id: 's1' }]);
  assert.deepEqual(state.unreadSessionIds, []);
});

test('removeSessionsFromState clears streaming when deleting the current session in batch', () => {
  const state = {
    sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    unreadSessionIds: ['s2', 's3'],
    currentSessionId: 's2',
    currentSession: { id: 's2' },
    isStreaming: true,
  };

  removeSessionsFromState(state, ['s1', 's2']);

  assert.equal(state.currentSessionId, null);
  assert.equal(state.currentSession, null);
  assert.equal(state.isStreaming, false);
  assert.deepEqual(state.sessions, [{ id: 's3' }]);
  assert.deepEqual(state.unreadSessionIds, ['s3']);
});
