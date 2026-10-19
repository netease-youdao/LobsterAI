import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { UsageEntry } from '../../shared/analytics/usage';
import { store } from '../store';
import { resetAccountSessionData } from '../store/accountSessionBoundary';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { setCurrentSession, setStreaming } from '../store/slices/coworkSlice';
import { type CoworkSession, CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';
import { beginTaskSubmission, finishTaskSubmission } from './usageAnalytics';

vi.mock('./i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./usageAnalytics', () => ({
  beginTaskSubmission: vi.fn(),
  finishTaskSubmission: vi.fn(),
  resetDraftAnalytics: vi.fn(),
}));

const session = (): CoworkSession => ({
  id: 'session-1', title: 'Task', claudeSessionId: null, scheduledTaskId: null, status: CoworkSessionStatusValue.Running,
  pinned: false, createdAt: 1, updatedAt: 1, cwd: '/work', systemPrompt: '', executionMode: 'local',
  modelOverride: '', agentId: 'main', activeSkillIds: [], messages: [], messagesOffset: 0, totalMessages: 0,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  coworkService.destroy();
  store.dispatch(resetAccountSessionData());
  vi.clearAllMocks();
  vi.mocked(beginTaskSubmission).mockReturnValue({ taskId: 'task', turnId: 'turn', entry: UsageEntry.Direct });
});

afterEach(() => { coworkService.destroy(); vi.unstubAllGlobals(); });

describe('account-bound task submissions', () => {
  test('sends local picker information and usage context together', async () => {
    const startSession = vi.fn().mockResolvedValue({ success: true, session: session() });
    vi.stubGlobal('window', { electron: { cowork: { startSession } } });
    const localInput = { text: 'Read the report', attachments: [] };
    await coworkService.startSession({ prompt: 'Read the report', localInput });
    expect(startSession).toHaveBeenCalledWith({
      prompt: 'Read the report', localInput,
      analytics: { taskId: 'task', turnId: 'turn', entry: UsageEntry.Direct },
    });
    expect(finishTaskSubmission).toHaveBeenCalledWith(expect.any(Object), 'session-1', undefined);
  });

  test.each([true, false])('an old start response cannot clear new-account streaming (success=%s)', async success => {
    const response = deferred<{ success: boolean; session?: CoworkSession }>();
    vi.stubGlobal('window', { electron: { cowork: { startSession: () => response.promise } } });
    const pending = coworkService.startSession({ prompt: 'Old account task' });
    store.dispatch(invalidateAuthAccountContext());
    store.dispatch(setCurrentSession(session()));
    store.dispatch(setStreaming(true));
    const currentSessions = store.getState().cowork.sessions;
    response.resolve({ success, session: success ? { ...session(), id: 'old-session' } : undefined });
    await expect(pending).rejects.toThrow('accountSessionChanged');
    expect(store.getState().cowork.isStreaming).toBe(true);
    expect(store.getState().cowork.sessions).toEqual(currentSessions);
  });

  test.each([true, false])('an old continuation cannot alter the new account (IPC rejection=%s)', async rejects => {
    const response = deferred<{ success: boolean }>();
    vi.stubGlobal('window', { electron: { cowork: { continueSession: () => response.promise } } });
    store.dispatch(setCurrentSession(session()));
    const pending = coworkService.continueSession({ sessionId: 'session-1', prompt: 'Continue' });
    store.dispatch(invalidateAuthAccountContext());
    store.dispatch(setCurrentSession(session()));
    store.dispatch(setStreaming(true));
    if (rejects) response.reject(new Error('Disconnected'));
    else response.resolve({ success: false });
    await expect(pending).rejects.toThrow();
    expect(store.getState().cowork.isStreaming).toBe(true);
    expect(store.getState().cowork.currentSession?.messages).toEqual([]);
    expect(store.getState().cowork.currentSession?.status).toBe(CoworkSessionStatusValue.Running);
  });

  test('a same-account start IPC failure clears its optimistic streaming state', async () => {
    vi.stubGlobal('window', { electron: { cowork: {
      startSession: vi.fn().mockRejectedValue(new Error('Disconnected')),
    } } });
    await expect(coworkService.startSession({ prompt: 'Start' })).rejects.toThrow('Disconnected');
    expect(store.getState().cowork.isStreaming).toBe(false);
    expect(finishTaskSubmission).toHaveBeenCalledWith(expect.any(Object), undefined, expect.any(Error));
  });
});
