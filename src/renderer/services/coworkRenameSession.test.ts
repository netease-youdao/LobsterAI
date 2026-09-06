import { afterEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setCurrentSession } from '../store/slices/coworkSlice';
import { type CoworkSession, CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';

const makeSession = (): CoworkSession => ({
  id: 'session-1',
  title: 'Original title',
  claudeSessionId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
});

afterEach(() => {
  store.dispatch(setCurrentSession(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('coworkService.renameSession', () => {
  test('updates the session title after a successful rename', async () => {
    const renameSession = vi.fn(async () => ({ success: true }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      electron: { cowork: { renameSession } },
      dispatchEvent,
    });
    store.dispatch(setCurrentSession(makeSession()));

    await expect(coworkService.renameSession('session-1', '  Renamed title  ')).resolves.toBe(true);

    expect(renameSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'Renamed title',
    });
    expect(store.getState().cowork.currentSession?.title).toBe('Renamed title');
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  test('shows a toast when the rename request is rejected', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          renameSession: vi.fn(async () => ({ success: false, error: 'database is locked' })),
        },
      },
      dispatchEvent,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(coworkService.renameSession('session-1', 'Renamed title')).resolves.toBe(false);

    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: 'app:showToast',
      detail: expect.any(String),
    });
  });

  test('catches IPC errors and shows a toast', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          renameSession: vi.fn(async () => {
            throw new Error('IPC disconnected');
          }),
        },
      },
      dispatchEvent,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(coworkService.renameSession('session-1', 'Renamed title')).resolves.toBe(false);

    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: 'app:showToast',
      detail: expect.any(String),
    });
  });
});
