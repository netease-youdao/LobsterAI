import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  CoworkSideChatMessageType,
  CoworkSideChatStatus,
} from '../shared/cowork/sideChat';
import { CoworkSideChatStore } from './coworkSideChatStore';

const openDatabases: Database.Database[] = [];

function createStore(): CoworkSideChatStore {
  const db = new Database(':memory:');
  openDatabases.push(db);
  return new CoworkSideChatStore(db);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe('CoworkSideChatStore', () => {
  test('persists side chats, ordered messages, metadata updates, and lookups by DSH session id', () => {
    const store = createStore();
    const created = store.createSideChat({
      parentSessionId: 'parent-1',
      title: 'Inspect retry config',
      forkedFromMessageId: 'msg-10',
      forkedAtSeq: 12,
    });

    expect(created.status).toBe(CoworkSideChatStatus.Idle);
    expect(created.messageCount).toBe(0);

    const updated = store.updateSideChat(created.id, {
      dshSessionId: 'dsh-side-1',
      status: CoworkSideChatStatus.Running,
    });
    expect(updated?.dshSessionId).toBe('dsh-side-1');
    expect(updated?.status).toBe(CoworkSideChatStatus.Running);
    expect(store.findByDshSessionId('dsh-side-1')?.id).toBe(created.id);

    const userMsg = store.addMessage(created.id, {
      type: CoworkSideChatMessageType.User,
      content: 'How many retries?',
      metadata: { selectedTextSnippets: [{ id: 's1', text: 'retry' }] },
    });
    const assistantMsg = store.addMessage(created.id, {
      type: CoworkSideChatMessageType.Assistant,
      content: 'Checking',
      metadata: { isStreaming: true },
    });
    store.updateMessageContent(created.id, assistantMsg.id, 'Max retries is 5.', {
      isStreaming: false,
      seq: 18,
    });

    const loaded = store.getSideChat(created.id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0].id).toBe(userMsg.id);
    expect(loaded?.messages[1].content).toBe('Max retries is 5.');
    expect(loaded?.messages[1].metadata).toEqual({ isStreaming: false, seq: 18 });
    expect(loaded?.messageCount).toBe(2);
  });

  test('resets stale running statuses on startup and cascades deletes per parent session', () => {
    const store = createStore();
    const sc1 = store.createSideChat({ parentSessionId: 'p1', title: 'First', dshSessionId: 'dsh-1' });
    const sc2 = store.createSideChat({ parentSessionId: 'p1', title: 'Second', dshSessionId: 'dsh-2' });
    const scOther = store.createSideChat({ parentSessionId: 'p2', title: 'Other', dshSessionId: 'dsh-3' });

    store.updateSideChat(sc1.id, { status: CoworkSideChatStatus.Running });
    store.addMessage(sc1.id, { type: CoworkSideChatMessageType.User, content: 'hi' });
    store.addMessage(sc2.id, { type: CoworkSideChatMessageType.User, content: 'hello' });

    expect(store.resetRunningStatusesOnStartup()).toBe(1);
    expect(store.getSideChatSummary(sc1.id)?.status).toBe(CoworkSideChatStatus.Idle);

    const deleted = store.deleteSideChatsByParentSession('p1');
    expect(deleted.map((item) => item.dshSessionId).sort()).toEqual(['dsh-1', 'dsh-2']);
    expect(store.listSideChats('p1')).toEqual([]);
    expect(store.getSideChat(sc1.id)).toBeNull();
    expect(store.listSideChats('p2').map((item) => item.id)).toEqual([scOther.id]);
  });
});
