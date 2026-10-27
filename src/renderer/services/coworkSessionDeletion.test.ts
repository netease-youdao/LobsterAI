import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setLoggedIn, setLoggedOut } from '../store/slices/authSlice';
import { addSession, setCurrentSession, setSessions } from '../store/slices/coworkSlice';
import { type CoworkSession, CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';
import { i18nService } from './i18n';

const session: CoworkSession = {
  id: 'delete-test', title: 'Task to delete', claudeSessionId: null, scheduledTaskId: null,
  status: CoworkSessionStatusValue.Completed, pinned: false, cwd: '/tmp', systemPrompt: '',
  modelOverride: '', executionMode: 'local', activeSkillIds: [], agentId: 'main',
  messages: [], messagesOffset: 0, totalMessages: 0, createdAt: 1, updatedAt: 2,
};
type DeleteResult = { success: boolean; error?: string };
const deleteSession = vi.fn<(id: string) => Promise<DeleteResult>>();
const seed = () => { store.dispatch(addSession(session)); store.dispatch(setCurrentSession(session)); };
const signIn = () => store.dispatch(setLoggedIn({ user: { yid: 'delete-owner', nickname: 'Test', avatarUrl: null },
  quota: null, ownerAccountKey: 'delete-owner' }));
beforeEach(() => {
  vi.clearAllMocks(); signIn(); store.dispatch(setSessions([])); seed();
  vi.stubGlobal('window', { electron: { cowork: { deleteSession } } });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('preserves a backend failure and keeps the task in the list and detail; boolean callers remain compatible', async () => {
  const result = { success: false, error: 'The task changed. Confirm deletion again.' };
  deleteSession.mockResolvedValue(result);
  await expect(coworkService.deleteSessionWithResult(session.id)).resolves.toEqual(result);
  await expect(coworkService.deleteSession(session.id)).resolves.toBe(false);
  expect(store.getState().cowork.sessions.map(item => item.id)).toContain(session.id);
  expect(store.getState().cowork.currentSession?.id).toBe(session.id);
});

test('removes the task only after a successful IPC result', async () => {
  let resolve!: (value: DeleteResult) => void;
  deleteSession.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = coworkService.deleteSessionWithResult(session.id);
  expect(store.getState().cowork.sessions.map(item => item.id)).toContain(session.id);
  resolve({ success: true });
  await expect(pending).resolves.toEqual({ success: true });
  expect(store.getState().cowork.sessions).toEqual([]); expect(store.getState().cowork.currentSession).toBeNull();
  seed(); deleteSession.mockResolvedValueOnce({ success: true });
  await expect(coworkService.deleteSession(session.id)).resolves.toBe(true);
});

test('keeps IPC rejections available to the dialog without removing the task', async () => {
  const failure = new Error('Deletion IPC unavailable'); deleteSession.mockRejectedValueOnce(failure);
  await expect(coworkService.deleteSessionWithResult(session.id)).rejects.toBe(failure);
  expect(store.getState().cowork.sessions.map(item => item.id)).toContain(session.id);
});

test('does not apply an old successful deletion after logout and login to the same owner', async () => {
  let resolve!: (value: DeleteResult) => void;
  deleteSession.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = coworkService.deleteSessionWithResult(session.id);
  store.dispatch(setLoggedOut()); signIn(); seed(); resolve({ success: true });
  await expect(pending).rejects.toThrow(i18nService.t('accountSessionChanged'));
  expect(store.getState().cowork.sessions.map(item => item.id)).toContain(session.id);
});
