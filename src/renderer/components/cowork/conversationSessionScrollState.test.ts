import { describe, expect, test, vi } from 'vitest';

import { ConversationScrollAnchorAttribute } from './conversationScrollAnchor';
import {
  getSessionRestoreAnchorMessageIds,
  getSessionRestoreWindow,
  hasUnreadProgressSinceSnapshot,
  SESSION_RESTORE_WINDOW_LEADING_CONTEXT,
  SESSION_RESTORE_WINDOW_PAGE_SIZE,
  SessionViewportMode,
  type SessionViewportSnapshot,
  SessionViewportStore,
} from './conversationSessionScrollState';

const makeReadingSnapshot = (
  overrides: Partial<SessionViewportSnapshot> = {},
): SessionViewportSnapshot => ({
  sessionId: 'session-1',
  mode: SessionViewportMode.Reading,
  anchor: {
    candidates: [
      {
        attribute: ConversationScrollAnchorAttribute.Message,
        messageId: 'message-40',
        offset: 64,
      },
      {
        attribute: ConversationScrollAnchorAttribute.Message,
        messageId: 'message-41',
        offset: 220,
      },
    ],
  },
  anchorAbsoluteIndex: 40,
  messagesOffset: 20,
  loadedMessageCount: 60,
  totalMessagesAtSave: 120,
  lastMessageIdAtSave: 'message-119',
  lastMessageLengthAtSave: 240,
  scrollTop: 1250,
  railIndex: 18,
  savedAt: 1000,
  ...overrides,
});

describe('SessionViewportStore', () => {
  test('maintains LRU ordering and evicts the least recently used session past capacity', () => {
    const store = new SessionViewportStore(2);
    store.save(makeReadingSnapshot({ sessionId: 's1' }));
    store.save(makeReadingSnapshot({ sessionId: 's2' }));
    // Touch s1 so s2 becomes the oldest entry.
    expect(store.get('s1')?.sessionId).toBe('s1');

    store.save(makeReadingSnapshot({ sessionId: 's3' }));
    expect(store.size()).toBe(2);
    expect(store.get('s2')).toBeNull();
    expect(store.get('s1')?.sessionId).toBe('s1');
    expect(store.get('s3')?.sessionId).toBe('s3');
  });

  test('deletes single, multiple, and all snapshots', () => {
    const store = new SessionViewportStore();
    store.save(makeReadingSnapshot({ sessionId: 's1' }));
    store.save(makeReadingSnapshot({ sessionId: 's2' }));
    store.save(makeReadingSnapshot({ sessionId: 's3' }));

    store.delete('s1');
    expect(store.get('s1')).toBeNull();
    store.deleteMany(['s2']);
    expect(store.get('s2')).toBeNull();
    expect(store.size()).toBe(1);

    store.clear();
    expect(store.size()).toBe(0);
  });

  test('synchronously captures and saves the active session viewport when expected ID matches', () => {
    const store = new SessionViewportStore();
    const snapshot = makeReadingSnapshot({ sessionId: 'session-a', scrollTop: 900 });
    const capturer = vi.fn(() => snapshot);
    const unregister = store.registerActiveCapturer('session-a', capturer);

    expect(store.captureActiveViewport('session-other')).toBeNull();
    expect(capturer).not.toHaveBeenCalled();

    expect(store.captureActiveViewport('session-a')).toEqual(snapshot);
    expect(capturer).toHaveBeenCalledTimes(1);
    expect(store.get('session-a')?.scrollTop).toBe(900);

    unregister();
    expect(store.captureActiveViewport('session-a')).toBeNull();
  });
});

describe('getSessionRestoreWindow', () => {
  test('returns null for missing snapshots or Bottom mode', () => {
    expect(getSessionRestoreWindow(null, 90, 30, 120)).toBeNull();
    expect(getSessionRestoreWindow(
      makeReadingSnapshot({ mode: SessionViewportMode.Bottom, anchor: null }),
      90,
      30,
      120,
    )).toBeNull();
  });

  test('returns null when the primary anchor message is already in the default tail page', () => {
    const defaultIds = new Set(['message-90', 'message-95', 'message-119']);
    const snapshot = makeReadingSnapshot({
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'message-95',
          offset: 40,
        }],
      },
      anchorAbsoluteIndex: 95,
    });

    expect(getSessionRestoreWindow(snapshot, 90, 30, 120, defaultIds)).toBeNull();
  });

  test('returns null when the entire session is already loaded in the default page', () => {
    expect(getSessionRestoreWindow(makeReadingSnapshot(), 0, 24, 24, new Set())).toBeNull();
  });

  test('computes a pre-fetch window with leading context when reading before the default tail page', () => {
    const defaultIds = new Set(['message-90', 'message-119']);
    const result = getSessionRestoreWindow(makeReadingSnapshot({ anchorAbsoluteIndex: 40 }), 90, 30, 120, defaultIds);

    expect(result).toEqual({
      offset: 40 - SESSION_RESTORE_WINDOW_LEADING_CONTEXT,
      limit: SESSION_RESTORE_WINDOW_PAGE_SIZE,
      expectedMessageId: 'message-40',
    });
  });

  test('clamps the pre-fetch offset to 0 near the start of a long conversation', () => {
    const snapshot = makeReadingSnapshot({
      anchor: {
        candidates: [{
          attribute: ConversationScrollAnchorAttribute.Message,
          messageId: 'message-3',
          offset: 12,
        }],
      },
      anchorAbsoluteIndex: 3,
    });

    expect(getSessionRestoreWindow(snapshot, 90, 30, 120, new Set(['message-119']))).toEqual({
      offset: 0,
      limit: SESSION_RESTORE_WINDOW_PAGE_SIZE,
      expectedMessageId: 'message-3',
    });
  });

  test('falls back to messagesOffset when anchorAbsoluteIndex is unavailable', () => {
    const snapshot = makeReadingSnapshot({
      anchor: null,
      anchorAbsoluteIndex: null,
      messagesOffset: 15,
    });

    expect(getSessionRestoreWindow(snapshot, 90, 30, 120, new Set(['message-119']))).toEqual({
      offset: 15 - SESSION_RESTORE_WINDOW_LEADING_CONTEXT,
      limit: SESSION_RESTORE_WINDOW_PAGE_SIZE,
    });
  });

  test('returns null when the anchor ID is missing and the fallback index lies inside the default page', () => {
    const snapshot = makeReadingSnapshot({
      anchorAbsoluteIndex: 105,
    });

    expect(getSessionRestoreWindow(snapshot, 90, 30, 120, new Set(['message-90']))).toBeNull();
  });
});

describe('getSessionRestoreAnchorMessageIds & hasUnreadProgressSinceSnapshot', () => {
  test('extracts anchor candidate IDs only for Reading snapshots', () => {
    expect(getSessionRestoreAnchorMessageIds(makeReadingSnapshot())).toEqual(['message-40', 'message-41']);
    expect(getSessionRestoreAnchorMessageIds(
      makeReadingSnapshot({ mode: SessionViewportMode.Bottom }),
    )).toEqual([]);
    expect(getSessionRestoreAnchorMessageIds(null)).toEqual([]);
  });

  test('detects unread progress from either message count growth or tail content streaming', () => {
    const snapshot = makeReadingSnapshot({
      totalMessagesAtSave: 40,
      lastMessageIdAtSave: 'message-39',
      lastMessageLengthAtSave: 120,
    });

    expect(hasUnreadProgressSinceSnapshot(snapshot, 40, { id: 'message-39', contentLength: 120 })).toBe(false);
    expect(hasUnreadProgressSinceSnapshot(snapshot, 42, { id: 'message-41', contentLength: 10 })).toBe(true);
    expect(hasUnreadProgressSinceSnapshot(snapshot, 40, { id: 'message-39', contentLength: 350 })).toBe(true);
    expect(hasUnreadProgressSinceSnapshot(
      makeReadingSnapshot({ mode: SessionViewportMode.Bottom, totalMessagesAtSave: 40 }),
      45,
    )).toBe(false);
  });
});
