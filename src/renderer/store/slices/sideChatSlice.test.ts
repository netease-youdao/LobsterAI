import { describe, expect, test } from 'vitest';

import {
  type CoworkSideChat,
  CoworkSideChatMessageType,
  CoworkSideChatStatus,
  type CoworkSideChatSummary,
} from '../../../shared/cowork/sideChat';
import reducer, {
  addSideChatPermission,
  appendSideChatMessage,
  clearParentSideChats,
  closeSideChatTab,
  openSideChatTab,
  removeSideChat,
  resolveSideChatPermission,
  setActiveSideChatTab,
  setSideChatDetail,
  setSideChatDraft,
  setSideChatStatus,
  setSideChatSummaries,
  updateSideChatMessage,
} from './sideChatSlice';

function makeSummary(overrides: Partial<CoworkSideChatSummary> = {}): CoworkSideChatSummary {
  return {
    id: 'sc-1',
    parentSessionId: 'p-1',
    dshSessionId: 'dsh-sc-1',
    title: 'Side chat',
    status: CoworkSideChatStatus.Idle,
    forkedFromMessageId: null,
    forkedAtSeq: null,
    lastError: null,
    messageCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('sideChatSlice', () => {
  test('opens multiple tabs per session, closes a tab without deleting persisted summary, and restores active neighbor', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, setSideChatSummaries({
      parentSessionId: 'p-1',
      sideChats: [
        makeSummary({ id: 'sc-1', title: 'First', updatedAt: 1000 }),
        makeSummary({ id: 'sc-2', title: 'Second', updatedAt: 2000 }),
      ],
    }));

    state = reducer(state, openSideChatTab({ parentSessionId: 'p-1', sideChatId: 'sc-1' }));
    state = reducer(state, openSideChatTab({ parentSessionId: 'p-1', sideChatId: 'sc-2' }));
    expect(state.openTabIdsByParent['p-1']).toEqual(['sc-1', 'sc-2']);
    expect(state.activeTabIdByParent['p-1']).toBe('sc-2');

    state = reducer(state, closeSideChatTab({ parentSessionId: 'p-1', sideChatId: 'sc-2' }));
    expect(state.openTabIdsByParent['p-1']).toEqual(['sc-1']);
    expect(state.activeTabIdByParent['p-1']).toBe('sc-1');
    // Closing a tab does NOT remove the persisted summary
    expect(state.summariesByParent['p-1'].map((s) => s.id)).toEqual(['sc-2', 'sc-1']);
  });

  test('streams messages, tracks unread state, handles permissions, and cleans up on delete', () => {
    const detail: CoworkSideChat = {
      ...makeSummary({ id: 'sc-1' }),
      messages: [],
    };
    let state = reducer(undefined, setSideChatDetail({ sideChat: detail }));
    state = reducer(state, setSideChatDraft({ sideChatId: 'sc-1', draft: 'hello' }));
    state = reducer(state, setSideChatStatus({
      parentSessionId: 'p-1',
      sideChatId: 'sc-1',
      status: CoworkSideChatStatus.Running,
    }));
    state = reducer(state, appendSideChatMessage({
      parentSessionId: 'p-1',
      sideChatId: 'sc-1',
      markUnread: true,
      message: {
        id: 'm-1',
        sideChatId: 'sc-1',
        type: CoworkSideChatMessageType.Assistant,
        content: 'Hel',
        metadata: { isStreaming: true },
        timestamp: 2000,
      },
    }));
    state = reducer(state, updateSideChatMessage({
      sideChatId: 'sc-1',
      messageId: 'm-1',
      content: 'Hello world',
      metadata: { isStreaming: false },
    }));

    expect(state.entitiesById['sc-1'].messages[0].content).toBe('Hello world');
    expect(state.unreadById['sc-1']).toBe(true);

    state = reducer(state, setActiveSideChatTab({ parentSessionId: 'p-1', sideChatId: 'sc-1' }));
    expect(state.unreadById['sc-1']).toBe(false);

    state = reducer(state, addSideChatPermission({
      parentSessionId: 'p-1',
      sideChatId: 'sc-1',
      requestId: 'req-1',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    }));
    expect(state.pendingPermissionsById['sc-1']).toHaveLength(1);
    state = reducer(state, resolveSideChatPermission({ sideChatId: 'sc-1', requestId: 'req-1' }));
    expect(state.pendingPermissionsById['sc-1']).toHaveLength(0);

    state = reducer(state, removeSideChat({ parentSessionId: 'p-1', sideChatId: 'sc-1' }));
    expect(state.entitiesById['sc-1']).toBeUndefined();
    expect(state.draftById['sc-1']).toBeUndefined();

    state = reducer(state, setSideChatSummaries({ parentSessionId: 'p-1', sideChats: [makeSummary({ id: 'sc-9' })] }));
    state = reducer(state, clearParentSideChats('p-1'));
    expect(state.summariesByParent['p-1']).toBeUndefined();
  });
});
