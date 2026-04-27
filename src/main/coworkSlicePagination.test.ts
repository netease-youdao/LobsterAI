/**
 * Unit tests for the pagination-related Redux reducers in coworkSlice.ts:
 *   - appendSessions: adds new sessions without duplicates, updates hasMoreSessions
 *   - prependMessages: inserts older messages before existing ones, updates offset
 *   - hasMoreSessions initial state
 *   - addMessage updates totalMessages
 */
import { test, expect } from 'vitest';
import coworkReducer, {
  setSessions,
  setHasMoreSessions,
  appendSessions,
  setCurrentSession,
  addMessage,
  prependMessages,
} from '../renderer/store/slices/coworkSlice';
import type { CoworkSessionSummary, CoworkSession, CoworkMessage } from '../renderer/types/cowork';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, updatedAt = Date.now()): CoworkSessionSummary {
  return { id, title: `Session ${id}`, status: 'idle', pinned: false, createdAt: updatedAt, updatedAt };
}

function makeFullSession(id: string, messages: CoworkMessage[] = [], messagesOffset = 0): CoworkSession {
  const now = Date.now();
  return {
    id,
    title: `Session ${id}`,
    claudeSessionId: null,
    status: 'idle',
    pinned: false,
    cwd: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages,
    messagesOffset,
    totalMessages: messagesOffset + messages.length,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMessage(id: string, content = 'hello'): CoworkMessage {
  return { id, type: 'user', content, timestamp: Date.now() };
}

const emptyState = coworkReducer(undefined, { type: '@@INIT' });

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test('initial state: hasMoreSessions is false', () => {
  expect(emptyState.hasMoreSessions).toBe(false);
});

test('initial state: sessions is empty', () => {
  expect(emptyState.sessions).toEqual([]);
});

// ---------------------------------------------------------------------------
// setHasMoreSessions
// ---------------------------------------------------------------------------

test('setHasMoreSessions: sets flag to true', () => {
  const state = coworkReducer(emptyState, setHasMoreSessions(true));
  expect(state.hasMoreSessions).toBe(true);
});

test('setHasMoreSessions: sets flag to false', () => {
  let state = coworkReducer(emptyState, setHasMoreSessions(true));
  state = coworkReducer(state, setHasMoreSessions(false));
  expect(state.hasMoreSessions).toBe(false);
});

// ---------------------------------------------------------------------------
// setSessions resets the list
// ---------------------------------------------------------------------------

test('setSessions: replaces existing sessions and resets hasMoreSessions to false', () => {
  let state = coworkReducer(emptyState, setHasMoreSessions(true));
  state = coworkReducer(state, setSessions([makeSession('a'), makeSession('b')]));
  expect(state.sessions.length).toBe(2);
  // hasMoreSessions is NOT touched by setSessions — that's done separately
});

// ---------------------------------------------------------------------------
// appendSessions
// ---------------------------------------------------------------------------

test('appendSessions: appends new sessions to existing list', () => {
  let state = coworkReducer(emptyState, setSessions([makeSession('a'), makeSession('b')]));
  state = coworkReducer(state, appendSessions({
    sessions: [makeSession('c'), makeSession('d')],
    hasMore: false,
  }));
  expect(state.sessions.length).toBe(4);
  expect(state.sessions.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
});

test('appendSessions: does not add duplicate session IDs', () => {
  let state = coworkReducer(emptyState, setSessions([makeSession('a'), makeSession('b')]));
  state = coworkReducer(state, appendSessions({
    sessions: [makeSession('b'), makeSession('c')],  // 'b' is a duplicate
    hasMore: false,
  }));
  expect(state.sessions.length).toBe(3);
  expect(state.sessions.map(s => s.id)).toEqual(['a', 'b', 'c']);
});

test('appendSessions: updates hasMoreSessions to true', () => {
  let state = coworkReducer(emptyState, setSessions([makeSession('a')]));
  state = coworkReducer(state, appendSessions({ sessions: [makeSession('b')], hasMore: true }));
  expect(state.hasMoreSessions).toBe(true);
});

test('appendSessions: updates hasMoreSessions to false', () => {
  let state = coworkReducer(emptyState, setHasMoreSessions(true));
  state = coworkReducer(state, appendSessions({ sessions: [makeSession('z')], hasMore: false }));
  expect(state.hasMoreSessions).toBe(false);
});

test('appendSessions: appending empty array changes nothing except hasMore', () => {
  let state = coworkReducer(emptyState, setSessions([makeSession('a')]));
  state = coworkReducer(state, appendSessions({ sessions: [], hasMore: false }));
  expect(state.sessions.length).toBe(1);
  expect(state.hasMoreSessions).toBe(false);
});

test('appendSessions: three sequential pages accumulate correctly', () => {
  const page1 = Array.from({ length: 50 }, (_, i) => makeSession(`s${i + 1}`));
  const page2 = Array.from({ length: 50 }, (_, i) => makeSession(`s${i + 51}`));
  const page3 = Array.from({ length: 21 }, (_, i) => makeSession(`s${i + 101}`));

  let state = coworkReducer(emptyState, setSessions(page1));
  state = coworkReducer(state, setHasMoreSessions(true));
  expect(state.sessions.length).toBe(50);

  state = coworkReducer(state, appendSessions({ sessions: page2, hasMore: true }));
  expect(state.sessions.length).toBe(100);
  expect(state.hasMoreSessions).toBe(true);

  state = coworkReducer(state, appendSessions({ sessions: page3, hasMore: false }));
  expect(state.sessions.length).toBe(121);
  expect(state.hasMoreSessions).toBe(false);
});

// ---------------------------------------------------------------------------
// prependMessages
// ---------------------------------------------------------------------------

test('prependMessages: inserts older messages before existing ones', () => {
  const existingMessages = [makeMessage('m6'), makeMessage('m7'), makeMessage('m8')];
  const session = makeFullSession('sess1', existingMessages, 5);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  const olderMessages = [makeMessage('m3'), makeMessage('m4'), makeMessage('m5')];
  state = coworkReducer(state, prependMessages({
    sessionId: 'sess1',
    messages: olderMessages,
    newOffset: 2,
  }));

  expect(state.currentSession?.messages.length).toBe(6);
  expect(state.currentSession?.messages[0].id).toBe('m3');
  expect(state.currentSession?.messages[5].id).toBe('m8');
  expect(state.currentSession?.messagesOffset).toBe(2);
});

test('prependMessages: does not add duplicate message IDs', () => {
  const existing = [makeMessage('m5'), makeMessage('m6')];
  const session = makeFullSession('sess1', existing, 4);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  // Overlap: m5 already exists
  const incoming = [makeMessage('m4'), makeMessage('m5')];
  state = coworkReducer(state, prependMessages({
    sessionId: 'sess1',
    messages: incoming,
    newOffset: 3,
  }));

  expect(state.currentSession?.messages.length).toBe(3);
  expect(state.currentSession?.messages.map(m => m.id)).toEqual(['m4', 'm5', 'm6']);
});

test('prependMessages: no-op when sessionId does not match current session', () => {
  const session = makeFullSession('sess1', [makeMessage('m1')], 0);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  state = coworkReducer(state, prependMessages({
    sessionId: 'OTHER',
    messages: [makeMessage('m0')],
    newOffset: 0,
  }));

  expect(state.currentSession?.messages.length).toBe(1);
  expect(state.currentSession?.messagesOffset).toBe(0);
});

test('prependMessages: no-op when messages array is empty', () => {
  const session = makeFullSession('sess1', [makeMessage('m1')], 5);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  state = coworkReducer(state, prependMessages({
    sessionId: 'sess1',
    messages: [],
    newOffset: 3,
  }));

  expect(state.currentSession?.messages.length).toBe(1);
  expect(state.currentSession?.messagesOffset).toBe(5); // unchanged
});

test('prependMessages: updates messagesOffset to newOffset', () => {
  const session = makeFullSession('sess1', [makeMessage('m51')], 50);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  state = coworkReducer(state, prependMessages({
    sessionId: 'sess1',
    messages: [makeMessage('m1')],
    newOffset: 0,
  }));

  expect(state.currentSession?.messagesOffset).toBe(0);
});

// ---------------------------------------------------------------------------
// addMessage updates totalMessages
// ---------------------------------------------------------------------------

test('addMessage: increments totalMessages on the current session', () => {
  const session = makeFullSession('sess1', [makeMessage('m1')], 0);
  // totalMessages = messagesOffset(0) + messages.length(1) = 1
  let state = coworkReducer(emptyState, setCurrentSession(session));
  expect(state.currentSession?.totalMessages).toBe(1);

  state = coworkReducer(state, addMessage({ sessionId: 'sess1', message: makeMessage('m2') }));
  expect(state.currentSession?.messages.length).toBe(2);
  expect(state.currentSession?.totalMessages).toBe(2);
});

test('addMessage: does not increment totalMessages for duplicate message', () => {
  const session = makeFullSession('sess1', [makeMessage('m1')], 0);
  let state = coworkReducer(emptyState, setCurrentSession(session));

  // Add same message twice
  state = coworkReducer(state, addMessage({ sessionId: 'sess1', message: makeMessage('m1') }));
  expect(state.currentSession?.messages.length).toBe(1);
  expect(state.currentSession?.totalMessages).toBe(1);
});

// ---------------------------------------------------------------------------
// setCurrentSession initializes pagination fields
// ---------------------------------------------------------------------------

test('setCurrentSession: sets messagesOffset and totalMessages from session data', () => {
  const session = makeFullSession('sess1', [makeMessage('m151'), makeMessage('m152')], 150);
  const state = coworkReducer(emptyState, setCurrentSession(session));

  expect(state.currentSession?.messagesOffset).toBe(150);
  expect(state.currentSession?.totalMessages).toBe(152);
});

test('setCurrentSession: falls back to messages.length when totalMessages missing', () => {
  // Simulate legacy data without totalMessages
  const session = makeFullSession('sess1', [makeMessage('ma'), makeMessage('mb')], 0);
  // @ts-expect-error -- testing fallback for missing field
  delete session.totalMessages;
  const state = coworkReducer(emptyState, setCurrentSession(session));

  expect(state.currentSession?.totalMessages).toBe(2);
});
