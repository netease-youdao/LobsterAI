import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setLoggedIn, setLoggedOut } from '../store/slices/authSlice';
import { addSession, deleteSession, setCurrentSession, setSessions, updateSessionTitle } from '../store/slices/coworkSlice';
import { type CoworkSession, CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';

const session: CoworkSession = {
  id: 'session-title-test', title: 'original prompt', claudeSessionId: null, scheduledTaskId: null,
  status: CoworkSessionStatusValue.Running, pinned: false, cwd: '/tmp', systemPrompt: '',
  modelOverride: '', executionMode: 'local', activeSkillIds: [], agentId: 'custom-agent',
  messages: [], messagesOffset: 0, totalMessages: 0, createdAt: 1, updatedAt: 2,
};

beforeEach(() => {
  store.dispatch(setLoggedIn({ user: { yid: 'title-test', nickname: 'Test', avatarUrl: null }, quota: null, ownerAccountKey: 'title-test' }));
  store.dispatch(setSessions([]));
  store.dispatch(addSession(session));
  store.dispatch(setCurrentSession(session));
});
afterEach(() => { vi.unstubAllGlobals(); });

test('applies a generated title to the list and open conversation without reordering', async () => {
  const generateSessionTitle = vi.fn(async () => 'Generated title');
  vi.stubGlobal('window', { electron: { generateSessionTitle } });
  await coworkService.generateSessionTitle(session.id, 'pure user text', session.title);
  expect(generateSessionTitle).toHaveBeenCalledOnce();
  expect(generateSessionTitle).toHaveBeenCalledWith({ sessionId: session.id, text: 'pure user text', expectedTitle: session.title });
  expect(store.getState().cowork.currentSession?.title).toBe('Generated title');
  expect(store.getState().cowork.sessions[0]).toMatchObject({ title: 'Generated title', updatedAt: 2 });
});

test.each(['rename', 'delete', 'logout'] as const)('ignores a late IPC response after %s', async (operation) => {
  let resolve!: (title: string) => void;
  vi.stubGlobal('window', { electron: { generateSessionTitle: () => new Promise<string>(done => { resolve = done; }) } });
  const pending = coworkService.generateSessionTitle(session.id, 'pure user text', session.title);
  if (operation === 'rename') store.dispatch(updateSessionTitle({ sessionId: session.id, title: 'Manual title' }));
  if (operation === 'delete') store.dispatch(deleteSession(session.id));
  if (operation === 'logout') store.dispatch(setLoggedOut());
  resolve('Stale title');
  await pending;
  expect(store.getState().cowork.sessions.find(item => item.id === session.id)?.title).not.toBe('Stale title');
});

test('skips empty input and silently settles an IPC rejection without retry', async () => {
  const generateSessionTitle = vi.fn(async () => { throw new Error('offline'); });
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { electron: { generateSessionTitle }, dispatchEvent });
  await coworkService.generateSessionTitle(session.id, '', session.title);
  expect(generateSessionTitle).not.toHaveBeenCalled();
  await coworkService.generateSessionTitle(session.id, 'pure user text', session.title);
  expect(generateSessionTitle).toHaveBeenCalledOnce();
  expect(dispatchEvent).not.toHaveBeenCalled();
  expect(store.getState().cowork.currentSession?.title).toBe(session.title);
});

test('updates the open conversation even when its sidebar page changed while awaiting the title', async () => {
  vi.stubGlobal('window', { electron: { generateSessionTitle: async () => 'Generated title' } });
  store.dispatch(setSessions([]));
  await coworkService.generateSessionTitle(session.id, 'pure user text', session.title);
  expect(store.getState().cowork.currentSession?.title).toBe('Generated title');
  expect(store.getState().cowork.currentSession?.updatedAt).toBe(2);
});
