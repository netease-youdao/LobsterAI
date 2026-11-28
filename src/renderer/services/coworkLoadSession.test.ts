import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  COWORK_TEMP_SESSION_ID_PREFIX,
  CoworkContextUsageSource,
} from '../../shared/cowork/constants';
import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { ConversationScrollAnchorAttribute } from '../components/cowork/conversationScrollAnchor';
import {
  SESSION_RESTORE_WINDOW_LEADING_CONTEXT,
  SESSION_RESTORE_WINDOW_PAGE_SIZE,
  SessionViewportMode,
  sessionViewportStore,
} from '../components/cowork/conversationSessionScrollState';
import { setPendingConversationSearch } from '../components/cowork/pendingConversationSearch';
import { store } from '../store';
import {
  addMessage,
  invalidateEditedHistory,
  setCurrentSession,
  setDraftPrompt,
  setMessageWindow,
} from '../store/slices/coworkSlice';
import {
  type CoworkContextUsage,
  type CoworkMessage,
  type CoworkSession,
  CoworkSessionStatusValue,
} from '../types/cowork';
import { coworkService } from './cowork';

const makeMessages = (count: number): CoworkMessage[] => Array.from(
  { length: count },
  (_, index) => ({
    id: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index,
  }),
);

const makeSession = (
  messages: CoworkMessage[],
  messagesOffset: number,
  totalMessages: number,
): CoworkSession => ({
  id: 'session-1',
  title: 'Session 1',
  claudeSessionId: null,
  scheduledTaskId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'main',
  messages,
  messagesOffset,
  totalMessages,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  sessionViewportStore.clear();
  setPendingConversationSearch('', '');
  coworkService.clearSession();
});

afterEach(() => {
  sessionViewportStore.clear();
  setPendingConversationSearch('', '');
  coworkService.clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('coworkService message edit projection', () => {
  test('keeps the bottom draft and rejects an old in-flight page after history is shortened', async () => {
    const oldMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(oldMessages.slice(20, 70), 20, 120)));
    store.dispatch(addMessage({ sessionId: 'session-1', message: oldMessages[120] }));
    store.dispatch(setDraftPrompt({ sessionId: 'session-1', draft: 'Unsent bottom draft' }));
    let resolvePage!: (value: { success: boolean; messages: CoworkMessage[]; offset: number; total: number }) => void;
    const page = new Promise<Parameters<typeof resolvePage>[0]>(resolve => { resolvePage = resolve; });
    const replacement = makeSession(makeMessages(6), 0, 6);
    vi.stubGlobal('window', { electron: { cowork: {
      getSessionMessages: vi.fn(() => page),
      editMessage: vi.fn(async () => ({ success: true })),
      getSession: vi.fn(async () => ({ success: true, session: replacement })),
      remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
    } } });

    const oldPage = coworkService.loadNewerMessages('session-1');
    await coworkService.editMessage({ sessionId: 'session-1', messageId: 'message-4', prompt: 'Corrected' });
    resolvePage({ success: true, messages: oldMessages.slice(70, 120), offset: 70, total: 121 });

    await expect(oldPage).resolves.toBe(false);
    const state = store.getState().cowork;
    expect(state.currentSession?.messages).toEqual(replacement.messages);
    expect(state.currentSession?.totalMessages).toBe(6);
    expect(state.detachedTailMessagesBySessionId['session-1']).toBeUndefined();
    expect(state.draftPrompts['session-1']).toBe('Unsent bottom draft');
  });

  test('leaves visible history intact when validation fails before rewind', async () => {
    const session = makeSession(makeMessages(8), 0, 8);
    store.dispatch(setCurrentSession(session));
    const getSession = vi.fn();
    vi.stubGlobal('window', { electron: { cowork: {
      editMessage: vi.fn(async () => ({ success: false, error: 'Missing attachment' })), getSession,
    } } });
    await expect(coworkService.editMessage({ sessionId: 'session-1', messageId: 'message-4', prompt: 'Corrected' }))
      .resolves.toMatchObject({ success: false });
    expect(getSession).not.toHaveBeenCalled();
    expect(store.getState().cowork.currentSession?.messages).toEqual(session.messages);
  });
});

describe('coworkService.loadSession', () => {
  test('preserves history already loaded before the default 30-message window', async () => {
    const allMessages = makeMessages(39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 39)));

    const getSession = vi.fn(async () => ({ success: true, session: defaultPageSession }));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages,
      offset: 0,
      total: 39,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await coworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      offset: 0,
      limit: 39,
    });
    expect(result?.messages).toHaveLength(39);
    expect(result?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(39);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
  });

  test('keeps the turn start of the preserved window instead of the default page', async () => {
    const allMessages = makeMessages(39);
    const defaultPageSession = {
      ...makeSession(allMessages.slice(9), 9, 39),
      leadingTurnStartTimestamp: 8,
    };
    store.dispatch(setCurrentSession({
      ...makeSession(allMessages.slice(5), 5, 39),
      leadingTurnStartTimestamp: 4,
    }));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages.slice(5),
            offset: 5,
            total: 39,
            leadingTurnStartTimestamp: 4,
          })),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    await coworkService.loadSession('session-1', { preserveLoadedRange: true });

    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(5);
    expect(store.getState().cowork.currentSession?.leadingTurnStartTimestamp).toBe(4);
  });

  test('does not request another message page when no earlier history was loaded', async () => {
    const allMessages = makeMessages(39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(defaultPageSession));

    const getSessionMessages = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    await coworkService.loadSession('session-1', { preserveLoadedRange: true });

    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  test('keeps the existing history view when preserving the loaded page fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const allMessages = makeMessages(39);
    const fullyLoadedSession = makeSession(allMessages, 0, 39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(fullyLoadedSession));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages: vi.fn(async () => {
            throw new Error('message page unavailable');
          }),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await coworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(result).toStrictEqual(fullyLoadedSession);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(39);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('keeping the existing view'),
      expect.any(Error),
    );
  });

  test('does not overwrite history that advances while a preserved page is loading', async () => {
    const allMessages = makeMessages(39);
    const messagesWithLiveUpdate = makeMessages(40);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 39)));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages: vi.fn(async () => {
            store.dispatch(setMessageWindow({
              sessionId: 'session-1',
              messages: messagesWithLiveUpdate,
              messagesOffset: 0,
              totalMessages: 40,
            }));
            return {
              success: true,
              messages: allMessages,
              offset: 0,
              total: 39,
            };
          }),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await coworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(result?.messages).toHaveLength(40);
    expect(result?.totalMessages).toBe(40);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(40);
  });
});

describe('coworkService.loadMessageWindowAroundIndex', () => {
  test('records where the turn of the jumped-to window began', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages.slice(0, 50),
            offset: 0,
            total: 120,
            leadingTurnStartTimestamp: null,
          })),
        },
      },
    });

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 20)).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.leadingTurnStartTimestamp).toBeNull();

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages.slice(35, 85),
            offset: 35,
            total: 120,
            leadingTurnStartTimestamp: 34,
          })),
        },
      },
    });

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 60)).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(35);
    expect(store.getState().cowork.currentSession?.leadingTurnStartTimestamp).toBe(34);
  });

  test('only applies the newest concurrent window request for a session', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(35, 85), 35, 120)));

    const resolvers = new Map<number, (value: {
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }) => void>();
    const getSessionMessages = vi.fn((options: { offset?: number }) => new Promise<{
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }>(resolve => {
      resolvers.set(options.offset ?? 0, resolve);
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    const olderRequest = coworkService.loadMessageWindowAroundIndex('session-1', 20);
    const newerRequest = coworkService.loadMessageWindowAroundIndex('session-1', 110);
    resolvers.get(70)?.({
      success: true,
      messages: allMessages.slice(70, 120),
      offset: 70,
      total: 120,
    });
    await expect(newerRequest).resolves.toBe(true);
    resolvers.get(0)?.({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(olderRequest).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not apply a response after the requesting search target becomes stale', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));

    let resolveMessages!: (value: {
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }) => void;
    const getSessionMessages = vi.fn(() => new Promise<{
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }>(resolve => {
      resolveMessages = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    let isRequestCurrent = true;
    const loadPromise = coworkService.loadMessageWindowAroundIndex('session-1', 20, {
      isRequestCurrent: () => isRequestCurrent,
    });
    isRequestCurrent = false;
    resolveMessages({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(loadPromise).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not apply a successful page that omits the expected search target', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 20, {
      expectedMessageId: 'message-no-longer-available',
    })).resolves.toBe(false);

    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not let an older window response roll back a live message total', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70, 120), 70, 120)));

    let resolveMessages!: (value: {
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }) => void;
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(() => new Promise(resolve => {
            resolveMessages = resolve;
          })),
        },
      },
    });

    const loadPromise = coworkService.loadMessageWindowAroundIndex('session-1', 20);
    store.dispatch(addMessage({ sessionId: 'session-1', message: allMessages[120] }));
    resolveMessages({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(loadPromise).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(121);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.detachedTailMessagesBySessionId['session-1']?.[50]?.id)
      .toBe('message-120');
  });

  test('accepts a lower authoritative total when the timeline shrank without a live race', async () => {
    const allMessages = makeMessages(10);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 12)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages,
            offset: 0,
            total: 10,
          })),
        },
      },
    });

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 9)).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(10);
  });
});

describe('coworkService.loadMoreMessages', () => {
  test('does not prepend when the view has cancelled its request', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));
    vi.stubGlobal('window', { electron: { cowork: {
      getSessionMessages: vi.fn(async () => ({ success: true, messages: allMessages.slice(20, 70) })),
    } } });
    await expect(coworkService.loadMoreMessages('session-1', () => false)).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(50);
  });

  test('captures immediately before prepend and preserves messages streamed while the page was loading', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70, 120), 70, 120)));
    let resolvePage!: (value: { success: boolean; messages: CoworkMessage[] }) => void;
    vi.stubGlobal('window', { electron: { cowork: {
      getSessionMessages: vi.fn(() => new Promise(resolve => { resolvePage = resolve; })),
    } } });
    const beforePrepend = vi.fn(() => {
      expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
      const latestMessages = store.getState().cowork.currentSession?.messages ?? [];
      expect(latestMessages[latestMessages.length - 1]?.id).toBe('message-120');
    });
    const pending = coworkService.loadMoreMessages('session-1', beforePrepend);
    expect(beforePrepend).not.toHaveBeenCalled();
    store.dispatch(addMessage({ sessionId: 'session-1', message: allMessages[120] }));
    resolvePage({ success: true, messages: allMessages.slice(20, 70) });
    await expect(pending).resolves.toBe(true);
    expect(beforePrepend).toHaveBeenCalledExactlyOnceWith(20);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(20).map(message => message.id),
    );
  });

  test('records where the turn of the prepended page began', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession({
      ...makeSession(allMessages.slice(70), 70, 120),
      leadingTurnStartTimestamp: 69,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages.slice(20, 70),
            offset: 20,
            total: 120,
            leadingTurnStartTimestamp: 19,
          })),
        },
      },
    });

    await expect(coworkService.loadMoreMessages('session-1')).resolves.toBe(true);

    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(20);
    expect(store.getState().cowork.currentSession?.leadingTurnStartTimestamp).toBe(19);
  });

  test('ignores an older page when search navigation replaces the window in flight', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(50, 100), 50, 120)));
    let resolveOlderPage!: (value: {
      success: boolean;
      messages: CoworkMessage[];
      offset: number;
      total: number;
    }) => void;
    let requestCount = 0;
    const getSessionMessages = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise(resolve => {
          resolveOlderPage = resolve;
        });
      }
      return Promise.resolve({
        success: true,
        messages: allMessages.slice(0, 50),
        offset: 0,
        total: 120,
      });
    });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionMessages } },
    });

    const beforePrepend = vi.fn();
    const olderPagePromise = coworkService.loadMoreMessages('session-1', beforePrepend);
    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 20)).resolves.toBe(true);
    resolveOlderPage({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(olderPagePromise).resolves.toBe(false);
    expect(beforePrepend).not.toHaveBeenCalled();
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(0, 50).map(message => message.id),
    );
  });
});

describe('coworkService.loadNewerMessages', () => {
  test('appends the page after the current message window', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages.slice(70, 120),
      offset: 70,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(coworkService.loadNewerMessages('session-1')).resolves.toBe(true);

    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      offset: 70,
      limit: 50,
    });
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(100);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(20);
    const loadedMessages = store.getState().cowork.currentSession?.messages ?? [];
    expect(loadedMessages[loadedMessages.length - 1]?.id).toBe('message-119');
  });

  test('ignores a newer page when navigation replaced the active window while loading', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => {
            store.dispatch(setMessageWindow({
              sessionId: 'session-1',
              messages: allMessages.slice(0, 50),
              messagesOffset: 0,
              totalMessages: 120,
            }));
            return {
              success: true,
              messages: allMessages.slice(70, 120),
              offset: 70,
              total: 120,
            };
          }),
        },
      },
    });

    await expect(coworkService.loadNewerMessages('session-1')).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(50);
    const loadedMessages = store.getState().cowork.currentSession?.messages ?? [];
    expect(loadedMessages[loadedMessages.length - 1]?.id).toBe('message-49');
  });

  test('keeps a middle window contiguous when live tail messages arrive before pagination', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    store.dispatch(addMessage({ sessionId: 'session-1', message: allMessages[120] }));

    expect(store.getState().cowork.currentSession?.messages).toHaveLength(50);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(121);

    const getSessionMessages = vi.fn(async (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
    }) => ({
      success: true,
      messages: options.offset === 70
        ? allMessages.slice(70, 120)
        : allMessages.slice(120, 121),
      offset: options.offset,
      total: 121,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(coworkService.loadNewerMessages('session-1')).resolves.toBe(true);
    await expect(coworkService.loadNewerMessages('session-1')).resolves.toBe(true);

    expect(getSessionMessages).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      offset: 70,
      limit: 50,
    });
    expect(getSessionMessages).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      offset: 120,
      limit: 1,
    });
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(20).map(message => message.id),
    );
    expect(store.getState().cowork.detachedTailMessagesBySessionId['session-1']).toBeUndefined();
  });

  test('returns false when a newer page contains no new message ids', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 120), 20, 121)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: [allMessages[119]],
            offset: 120,
            total: 121,
          })),
        },
      },
    });

    await expect(coworkService.loadNewerMessages('session-1')).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(100);
  });
});

describe('coworkService rail navigation loading', () => {
  test('supports forward-biased leadingContext when jumping to a rail turn', async () => {
    const allMessages = makeMessages(200);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(170), 170, 200)));
    const getSessionMessages = vi.fn(async (options: { offset: number; limit: number }) => ({
      success: true,
      messages: allMessages.slice(options.offset, options.offset + options.limit),
      offset: options.offset,
      total: 200,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 80, {
      pageSize: 60,
      leadingContext: 6,
      expectedMessageId: 'message-80',
    })).resolves.toBe(true);

    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      offset: 74,
      limit: 60,
    });
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(74);
  });

  test('keeps an in-flight rail index load alive across pagination window jumps and deduplicates concurrent callers', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(90), 90, 120)));

    let resolveRailIndex!: (value: {
      success: boolean;
      items: Array<{
        messageId: string;
        type: 'user' | 'assistant';
        sequence: number;
        messageOffset: number;
        timestamp: number;
        preview: string;
        contentLen: number;
      }>;
    }) => void;
    const getSessionMessageRailIndex = vi.fn(() => new Promise<{
      success: boolean;
      items: Array<{
        messageId: string;
        type: 'user' | 'assistant';
        sequence: number;
        messageOffset: number;
        timestamp: number;
        preview: string;
        contentLen: number;
      }>;
    }>(resolve => {
      resolveRailIndex = resolve;
    }));
    const getSessionMessages = vi.fn(async (options: { offset: number; limit: number }) => ({
      success: true,
      messages: allMessages.slice(options.offset, options.offset + options.limit),
      offset: options.offset,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessageRailIndex, getSessionMessages },
      },
    });

    const firstRailPromise = coworkService.loadSessionMessageRailIndex('session-1');
    const secondRailPromise = coworkService.loadSessionMessageRailIndex('session-1');
    expect(getSessionMessageRailIndex).toHaveBeenCalledTimes(1);

    await expect(coworkService.loadMessageWindowAroundIndex('session-1', 0)).resolves.toBe(true);

    const railItems = [{
      messageId: 'message-0',
      type: 'user' as const,
      sequence: 1,
      messageOffset: 0,
      timestamp: 1000,
      preview: 'First prompt',
      contentLen: 12,
    }];
    resolveRailIndex({ success: true, items: railItems });

    await expect(firstRailPromise).resolves.toEqual(railItems);
    await expect(secondRailPromise).resolves.toEqual(railItems);
    expect(store.getState().cowork.messageRailIndexBySessionId['session-1']).toEqual(railItems);
  });

  test('pre-fetches the saved reading window when switching back to a session outside the tail page', async () => {
    const allMessages = makeMessages(120);
    const tailPage = makeSession(allMessages.slice(90), 90, 120);
    const otherSession: CoworkSession = { ...makeSession(makeMessages(6), 0, 6), id: 'session-2' };
    store.dispatch(setCurrentSession(otherSession));

    const captureOther = vi.fn(() => ({
      sessionId: 'session-2',
      mode: SessionViewportMode.Reading,
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'message-2',
          offset: 30,
        }],
      },
      anchorAbsoluteIndex: 2,
      messagesOffset: 0,
      loadedMessageCount: 6,
      totalMessagesAtSave: 6,
      scrollTop: 180,
      railIndex: 1,
      savedAt: 500,
    }));
    const unregister = sessionViewportStore.registerActiveCapturer('session-2', captureOther);

    sessionViewportStore.save({
      sessionId: 'session-1',
      mode: SessionViewportMode.Reading,
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'message-35',
          offset: 48,
        }],
      },
      anchorAbsoluteIndex: 35,
      messagesOffset: 20,
      loadedMessageCount: 60,
      totalMessagesAtSave: 115,
      scrollTop: 920,
      railIndex: 17,
      savedAt: 1000,
    });

    const getSession = vi.fn(async () => ({ success: true, session: tailPage }));
    const getSessionMessages = vi.fn(async (options: { offset: number; limit: number }) => ({
      success: true,
      messages: allMessages.slice(options.offset, options.offset + options.limit),
      offset: options.offset,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    try {
      const loaded = await coworkService.loadSession('session-1');
      const expectedOffset = 35 - SESSION_RESTORE_WINDOW_LEADING_CONTEXT;
      expect(getSessionMessages).toHaveBeenCalledWith({
        sessionId: 'session-1',
        offset: expectedOffset,
        limit: SESSION_RESTORE_WINDOW_PAGE_SIZE,
      });
      expect(loaded?.messagesOffset).toBe(expectedOffset);
      expect(loaded?.messages.some(message => message.id === 'message-35')).toBe(true);
      expect(store.getState().cowork.currentSession?.messagesOffset).toBe(expectedOffset);
      // Leaving session-2 captured its viewport right before switching to session-1.
      expect(captureOther).toHaveBeenCalledTimes(1);
      expect(sessionViewportStore.get('session-2')?.scrollTop).toBe(180);
    } finally {
      unregister();
    }
  });

  test('falls back to the default tail page and clears stale snapshot when saved anchor is missing', async () => {
    const allMessages = makeMessages(120);
    const tailPage = makeSession(allMessages.slice(90), 90, 120);
    sessionViewportStore.save({
      sessionId: 'session-1',
      mode: SessionViewportMode.Reading,
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'deleted-message-id',
          offset: 20,
        }],
      },
      anchorAbsoluteIndex: 30,
      messagesOffset: 10,
      loadedMessageCount: 50,
      totalMessagesAtSave: 120,
      scrollTop: 400,
      railIndex: 10,
      savedAt: 1000,
    });

    const getSession = vi.fn(async () => ({ success: true, session: tailPage }));
    const getSessionMessages = vi.fn(async (options: { offset: number; limit: number }) => ({
      success: true,
      messages: allMessages.slice(options.offset, options.offset + options.limit),
      offset: options.offset,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const loaded = await coworkService.loadSession('session-1');
    expect(loaded?.messagesOffset).toBe(90);
    expect(sessionViewportStore.get('session-1')).toBeNull();
  });

  test('skips saved reading window pre-fetch when a pending conversation search targets the session', async () => {
    const allMessages = makeMessages(120);
    const tailPage = makeSession(allMessages.slice(90), 90, 120);
    sessionViewportStore.save({
      sessionId: 'session-1',
      mode: SessionViewportMode.Reading,
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'message-20',
          offset: 20,
        }],
      },
      anchorAbsoluteIndex: 20,
      messagesOffset: 0,
      loadedMessageCount: 60,
      totalMessagesAtSave: 120,
      scrollTop: 500,
      railIndex: 10,
      savedAt: 1000,
    });
    setPendingConversationSearch('session-1', 'needle');

    const getSession = vi.fn(async () => ({ success: true, session: tailPage }));
    const getSessionMessages = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const loaded = await coworkService.loadSession('session-1');
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(loaded?.messagesOffset).toBe(90);
  });
});

describe('coworkService session-entry context usage refresh', () => {
  const makeUsage = (sessionId: string, percent: number): CoworkContextUsage => ({
    sessionId,
    usedTokens: percent * 1_000,
    contextTokens: 100_000,
    percent,
    status: 'normal',
    updatedAt: 1_000,
  });

  beforeEach(() => {
    coworkService.destroy();
    store.dispatch(invalidateEditedHistory('session-a'));
    store.dispatch(invalidateEditedHistory('session-b'));
  });

  afterEach(() => {
    coworkService.destroy();
    vi.useRealTimers();
  });

  test('refreshes context usage on loadSession and respects cooldown across rapid switches', async () => {
    vi.useFakeTimers();
    const sessionA: CoworkSession = { ...makeSession(makeMessages(4), 0, 4), id: 'session-a' };
    const sessionB: CoworkSession = { ...makeSession(makeMessages(4), 0, 4), id: 'session-b' };
    const getContextUsage = vi.fn(async (sessionId: string) => ({
      success: true as const,
      usage: makeUsage(sessionId, sessionId === 'session-a' ? 12 : 45),
      source: CoworkContextUsageSource.Live,
    }));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async (id: string) => ({
            success: true,
            session: id === 'session-a' ? sessionA : sessionB,
          })),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
          getContextUsage,
        },
      },
    });

    await coworkService.loadSession('session-a');
    await Promise.resolve();
    expect(store.getState().cowork.contextUsageBySessionId['session-a']?.percent).toBe(12);

    // Calling entry refresh again immediately (e.g. from CoworkSessionDetail useEffect) hits cooldown.
    coworkService.refreshContextUsageForSessionEntry('session-a');
    coworkService.refreshContextUsageForSessionEntry(`${COWORK_TEMP_SESSION_ID_PREFIX}1`);
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    // Switching to another task loads its usage without losing the previous session's cached usage.
    await coworkService.loadSession('session-b');
    await Promise.resolve();
    expect(store.getState().cowork.contextUsageBySessionId['session-b']?.percent).toBe(45);
    expect(store.getState().cowork.contextUsageBySessionId['session-a']?.percent).toBe(12);

    // After cooldown elapses, returning to session-a refreshes again.
    vi.advanceTimersByTime(1_600);
    await coworkService.loadSession('session-a');
    await Promise.resolve();
    expect(getContextUsage).toHaveBeenCalledTimes(3);
  });

  test('defers entry refresh while engine is starting and refreshes active session once running', async () => {
    const sessionA: CoworkSession = { ...makeSession(makeMessages(4), 0, 4), id: 'session-a' };
    const progressListeners: Array<(status: { phase: OpenClawEnginePhase }) => void> = [];
    const getContextUsage = vi.fn(async (sessionId: string) => ({
      success: true as const,
      usage: makeUsage(sessionId, 28),
      source: CoworkContextUsageSource.Live,
    }));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: sessionA })),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
          getContextUsage,
        },
        openclaw: {
          engine: {
            getStatus: vi.fn(async () => ({
              success: true,
              status: { phase: OpenClawEnginePhase.Starting },
            })),
            onProgress: vi.fn((cb: (status: { phase: OpenClawEnginePhase }) => void) => {
              progressListeners.push(cb);
              return () => {
                const idx = progressListeners.indexOf(cb);
                if (idx >= 0) progressListeners.splice(idx, 1);
              };
            }),
          },
        },
      },
    });

    await coworkService.loadOpenClawEngineStatus();
    await coworkService.loadSession('session-a');
    expect(getContextUsage).not.toHaveBeenCalled();

    progressListeners.forEach(listener => listener({ phase: OpenClawEnginePhase.Running }));
    await Promise.resolve();
    await Promise.resolve();

    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(getContextUsage).toHaveBeenCalledWith('session-a');
    expect(store.getState().cowork.contextUsageBySessionId['session-a']?.percent).toBe(28);
  });

  test('suppresses repeated auto lookups after unavailable and refreshes after version switch', async () => {
    vi.useFakeTimers();
    const sessionA: CoworkSession = { ...makeSession(makeMessages(4), 0, 4), id: 'session-a' };
    const getContextUsage = vi.fn()
      .mockResolvedValueOnce({
        success: true as const,
        usage: null,
        source: CoworkContextUsageSource.Unavailable,
      })
      .mockResolvedValueOnce({
        success: true as const,
        usage: makeUsage('session-a', 19),
        source: CoworkContextUsageSource.Live,
      });

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: sessionA })),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
          switchMessageVersion: vi.fn(async () => ({ success: true })),
          getContextUsage,
        },
      },
    });

    await coworkService.loadSession('session-a');
    await Promise.resolve();
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    // Even after the 1.5s entry cooldown, Unavailable suppresses auto retries.
    vi.advanceTimersByTime(2_000);
    await coworkService.loadSession('session-a');
    await Promise.resolve();
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    // Switching message version invalidates history and clears suppression so usage refreshes.
    await coworkService.switchMessageVersion({
      sessionId: 'session-a',
      messageId: 'message-0',
      targetIndex: 1,
    });
    await Promise.resolve();
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.contextUsageBySessionId['session-a']?.percent).toBe(19);
  });

  test('does not schedule post-run polling on stream complete and applies pushed context usage updates', async () => {
    vi.useFakeTimers();
    const sessionA: CoworkSession = { ...makeSession(makeMessages(4), 0, 4), id: 'session-a' };
    const completeListeners: Array<(payload: { sessionId: string }) => void> = [];
    const contextUsageListeners: Array<(payload: { sessionId: string; usage: CoworkContextUsage }) => void> = [];
    const getContextUsage = vi.fn(async (sessionId: string) => ({
      success: true as const,
      usage: makeUsage(sessionId, 33),
      source: CoworkContextUsageSource.Live,
    }));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: sessionA })),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
          getContextUsage,
          onStreamMessage: vi.fn(() => () => undefined),
          onStreamMessageUpdate: vi.fn(() => () => undefined),
          onStreamPermission: vi.fn(() => () => undefined),
          onStreamPermissionDismiss: vi.fn(() => () => undefined),
          onStreamComplete: vi.fn((cb: (payload: { sessionId: string }) => void) => {
            completeListeners.push(cb);
            return () => undefined;
          }),
          onStreamError: vi.fn(() => () => undefined),
          onSessionsChanged: vi.fn(() => () => undefined),
          onStreamContextUsage: vi.fn((cb: (payload: { sessionId: string; usage: CoworkContextUsage }) => void) => {
            contextUsageListeners.push(cb);
            return () => undefined;
          }),
        },
      },
    });

    (coworkService as unknown as { setupStreamListeners: () => void }).setupStreamListeners();
    store.dispatch(setCurrentSession(sessionA));

    // Stream completion must not schedule delayed getContextUsage polling timers.
    completeListeners.forEach(cb => cb({ sessionId: 'session-a' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getContextUsage).not.toHaveBeenCalled();

    // Pushed usage with breakdown updates Redux immediately.
    const pushedUsage: CoworkContextUsage = {
      ...makeUsage('session-a', 42),
      breakdown: {
        systemTokens: 10_000,
        toolsTokens: 7_000,
        messageTokens: 25_000,
      },
    };
    contextUsageListeners.forEach(cb => cb({ sessionId: 'session-a', usage: pushedUsage }));
    expect(store.getState().cowork.contextUsageBySessionId['session-a']).toEqual(pushedUsage);
  });

  test('coalesces streaming messageUpdate bursts per frame and prevents stopped sessions from flipping back to running', async () => {
    vi.useFakeTimers();
    const runningSession: CoworkSession = {
      ...makeSession([
        { id: 'u1', type: 'user', content: 'hi', timestamp: 1 },
        { id: 'a1', type: 'assistant', content: '', timestamp: 2, metadata: { isStreaming: true } },
      ], 0, 2),
      id: 'session-stream',
      status: CoworkSessionStatusValue.Running,
    };
    const updateListeners: Array<(payload: {
      sessionId: string;
      messageId: string;
      content: string;
      metadata?: Record<string, unknown>;
    }) => void> = [];
    const rafQueue: Array<() => void> = [];

    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((cb: () => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      }),
      cancelAnimationFrame: vi.fn(),
      electron: {
        cowork: {
          stopSession: vi.fn(async () => ({ success: true })),
          onStreamMessage: vi.fn(() => () => undefined),
          onStreamMessageUpdate: vi.fn((cb: (payload: {
            sessionId: string;
            messageId: string;
            content: string;
            metadata?: Record<string, unknown>;
          }) => void) => {
            updateListeners.push(cb);
            return () => undefined;
          }),
          onStreamPermission: vi.fn(() => () => undefined),
          onStreamPermissionDismiss: vi.fn(() => () => undefined),
          onStreamComplete: vi.fn(() => () => undefined),
          onStreamError: vi.fn(() => () => undefined),
          onSessionsChanged: vi.fn(() => () => undefined),
        },
      },
    });

    (coworkService as unknown as { setupStreamListeners: () => void }).setupStreamListeners();
    store.dispatch(setCurrentSession(runningSession));

    // Rapid streaming updates within a single frame coalesce to one RAF flush.
    for (let i = 1; i <= 20; i += 1) {
      updateListeners.forEach(cb => cb({
        sessionId: 'session-stream',
        messageId: 'a1',
        content: `chunk-${i}`,
        metadata: { isStreaming: true },
      }));
    }
    expect(rafQueue).toHaveLength(1);
    expect(store.getState().cowork.currentSession?.messages[1]?.content).toBe('');

    rafQueue.shift()?.();
    expect(store.getState().cowork.currentSession?.messages[1]?.content).toBe('chunk-20');

    // Queue another streaming update, then stop the session before the next frame fires.
    updateListeners.forEach(cb => cb({
      sessionId: 'session-stream',
      messageId: 'a1',
      content: 'stale-pre-stop',
      metadata: { isStreaming: true },
    }));
    await coworkService.stopSession('session-stream');
    expect(store.getState().cowork.currentSession?.status).toBe(CoworkSessionStatusValue.Idle);
    expect(store.getState().cowork.isStreaming).toBe(false);

    // Even if a queued RAF callback runs afterwards, it must not resurrect running status.
    while (rafQueue.length > 0) rafQueue.shift()?.();
    expect(store.getState().cowork.currentSession?.status).toBe(CoworkSessionStatusValue.Idle);
    expect(store.getState().cowork.currentSession?.messages[1]?.content).toBe('chunk-20');

    // Finalization update (`isStreaming: false`) applies immediately without flipping idle -> running.
    updateListeners.forEach(cb => cb({
      sessionId: 'session-stream',
      messageId: 'a1',
      content: 'final-stopped-text',
      metadata: { isStreaming: false },
    }));
    expect(store.getState().cowork.currentSession?.messages[1]?.content).toBe('final-stopped-text');
    expect(store.getState().cowork.currentSession?.status).toBe(CoworkSessionStatusValue.Idle);
  });
});
