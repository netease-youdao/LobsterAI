import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  type CoworkSideChat,
  type CoworkSideChatMessage,
  CoworkSideChatMessageType,
  type CoworkSideChatPermissionRequest,
  CoworkSideChatStatus,
  type CoworkSideChatSummary,
} from '../../../shared/cowork/sideChat';
import type { ModelPresetId } from '../../../shared/modelPresets/constants';
import type { ModelThinkingLevel } from '../../../shared/providers';
import type { DraftAttachment } from './coworkSlice';

export interface SideChatModelSelection {
  modelOverride: string;
  thinkingLevel: ModelThinkingLevel | null;
  modelPresetId?: ModelPresetId | null;
}

export interface SideChatState {
  summariesByParent: Record<string, CoworkSideChatSummary[]>;
  entitiesById: Record<string, CoworkSideChat>;
  openTabIdsByParent: Record<string, string[]>;
  activeTabIdByParent: Record<string, string | null>;
  draftById: Record<string, string>;
  selectedTextSnippetsById: Record<string, CoworkSelectedTextSnippet[]>;
  attachmentsById: Record<string, DraftAttachment[]>;
  modelSelectionById: Record<string, SideChatModelSelection>;
  pendingPermissionsById: Record<string, CoworkSideChatPermissionRequest[]>;
  unreadById: Record<string, boolean>;
}

const initialState: SideChatState = {
  summariesByParent: {},
  entitiesById: {},
  openTabIdsByParent: {},
  activeTabIdByParent: {},
  draftById: {},
  selectedTextSnippetsById: {},
  attachmentsById: {},
  modelSelectionById: {},
  pendingPermissionsById: {},
  unreadById: {},
};

function sortSummaries(list: CoworkSideChatSummary[]): CoworkSideChatSummary[] {
  return [...list].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
}

function upsertSummaryInList(
  list: CoworkSideChatSummary[] | undefined,
  summary: CoworkSideChatSummary,
): CoworkSideChatSummary[] {
  const existing = list ?? [];
  const next = existing.filter((item) => item.id !== summary.id);
  next.push(summary);
  return sortSummaries(next);
}

const sideChatSlice = createSlice({
  name: 'sideChat',
  initialState,
  reducers: {
    setSideChatSummaries(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChats: CoworkSideChatSummary[] }>,
    ) {
      const { parentSessionId, sideChats } = action.payload;
      state.summariesByParent[parentSessionId] = sortSummaries(sideChats);
      for (const summary of sideChats) {
        const entity = state.entitiesById[summary.id];
        if (entity) {
          state.entitiesById[summary.id] = {
            ...entity,
            ...summary,
            messages: entity.messages,
          };
        }
      }
      const validIds = new Set(sideChats.map((item) => item.id));
      const openTabs = state.openTabIdsByParent[parentSessionId];
      if (openTabs) {
        const filtered = openTabs.filter((id) => validIds.has(id));
        state.openTabIdsByParent[parentSessionId] = filtered;
        const activeId = state.activeTabIdByParent[parentSessionId];
        if (activeId && !validIds.has(activeId)) {
          state.activeTabIdByParent[parentSessionId] = filtered[filtered.length - 1] ?? null;
        }
      }
    },

    upsertSideChatSummary(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChat: CoworkSideChatSummary }>,
    ) {
      const { parentSessionId, sideChat } = action.payload;
      state.summariesByParent[parentSessionId] = upsertSummaryInList(
        state.summariesByParent[parentSessionId],
        sideChat,
      );
      const entity = state.entitiesById[sideChat.id];
      if (entity) {
        state.entitiesById[sideChat.id] = {
          ...entity,
          ...sideChat,
          messages: entity.messages,
        };
      }
    },

    setSideChatDetail(
      state,
      action: PayloadAction<{
        sideChat: CoworkSideChat;
        pendingPermissions?: CoworkSideChatPermissionRequest[];
      }>,
    ) {
      const { sideChat, pendingPermissions } = action.payload;
      state.entitiesById[sideChat.id] = sideChat;
      const summary: CoworkSideChatSummary = {
        id: sideChat.id,
        parentSessionId: sideChat.parentSessionId,
        dshSessionId: sideChat.dshSessionId,
        title: sideChat.title,
        status: sideChat.status,
        forkedFromMessageId: sideChat.forkedFromMessageId,
        forkedAtSeq: sideChat.forkedAtSeq,
        lastError: sideChat.lastError,
        messageCount: sideChat.messages.length,
        createdAt: sideChat.createdAt,
        updatedAt: sideChat.updatedAt,
      };
      state.summariesByParent[sideChat.parentSessionId] = upsertSummaryInList(
        state.summariesByParent[sideChat.parentSessionId],
        summary,
      );
      if (pendingPermissions !== undefined) {
        state.pendingPermissionsById[sideChat.id] = pendingPermissions;
      }
    },

    openSideChatTab(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChatId: string; activate?: boolean }>,
    ) {
      const { parentSessionId, sideChatId, activate = true } = action.payload;
      const existing = state.openTabIdsByParent[parentSessionId] ?? [];
      if (!existing.includes(sideChatId)) {
        state.openTabIdsByParent[parentSessionId] = [...existing, sideChatId];
      }
      if (activate) {
        state.activeTabIdByParent[parentSessionId] = sideChatId;
        state.unreadById[sideChatId] = false;
      }
    },

    setActiveSideChatTab(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChatId: string | null }>,
    ) {
      const { parentSessionId, sideChatId } = action.payload;
      state.activeTabIdByParent[parentSessionId] = sideChatId;
      if (sideChatId) {
        state.unreadById[sideChatId] = false;
      }
    },

    closeSideChatTab(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChatId: string }>,
    ) {
      const { parentSessionId, sideChatId } = action.payload;
      const existing = state.openTabIdsByParent[parentSessionId] ?? [];
      const idx = existing.indexOf(sideChatId);
      if (idx === -1) return;
      const next = existing.filter((id) => id !== sideChatId);
      state.openTabIdsByParent[parentSessionId] = next;
      if (state.activeTabIdByParent[parentSessionId] === sideChatId) {
        state.activeTabIdByParent[parentSessionId] = next[idx] ?? next[idx - 1] ?? null;
      }
    },

    removeSideChat(
      state,
      action: PayloadAction<{ parentSessionId: string; sideChatId: string }>,
    ) {
      const { parentSessionId, sideChatId } = action.payload;
      const summaries = state.summariesByParent[parentSessionId];
      if (summaries) {
        state.summariesByParent[parentSessionId] = summaries.filter((item) => item.id !== sideChatId);
      }
      const tabs = state.openTabIdsByParent[parentSessionId];
      if (tabs) {
        const idx = tabs.indexOf(sideChatId);
        const nextTabs = tabs.filter((id) => id !== sideChatId);
        state.openTabIdsByParent[parentSessionId] = nextTabs;
        if (state.activeTabIdByParent[parentSessionId] === sideChatId) {
          state.activeTabIdByParent[parentSessionId] = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
        }
      }
      delete state.entitiesById[sideChatId];
      delete state.draftById[sideChatId];
      delete state.selectedTextSnippetsById[sideChatId];
      delete state.attachmentsById[sideChatId];
      delete state.modelSelectionById[sideChatId];
      delete state.pendingPermissionsById[sideChatId];
      delete state.unreadById[sideChatId];
    },

    clearParentSideChats(state, action: PayloadAction<string>) {
      const parentSessionId = action.payload;
      const summaries = state.summariesByParent[parentSessionId] ?? [];
      for (const item of summaries) {
        delete state.entitiesById[item.id];
        delete state.draftById[item.id];
        delete state.selectedTextSnippetsById[item.id];
        delete state.attachmentsById[item.id];
        delete state.modelSelectionById[item.id];
        delete state.pendingPermissionsById[item.id];
        delete state.unreadById[item.id];
      }
      delete state.summariesByParent[parentSessionId];
      delete state.openTabIdsByParent[parentSessionId];
      delete state.activeTabIdByParent[parentSessionId];
    },

    appendSideChatMessage(
      state,
      action: PayloadAction<{
        parentSessionId: string;
        sideChatId: string;
        message: CoworkSideChatMessage;
        markUnread?: boolean;
      }>,
    ) {
      const { parentSessionId, sideChatId, message, markUnread } = action.payload;
      let entity = state.entitiesById[sideChatId];
      if (!entity) {
        const summary = state.summariesByParent[parentSessionId]?.find((item) => item.id === sideChatId);
        if (!summary) return;
        entity = { ...summary, messages: [] };
        state.entitiesById[sideChatId] = entity;
      }
      const existingIdx = entity.messages.findIndex((item) => item.id === message.id);
      if (existingIdx >= 0) {
        entity.messages[existingIdx] = message;
      } else {
        entity.messages.push(message);
      }
      entity.messageCount = entity.messages.length;
      entity.updatedAt = Math.max(entity.updatedAt, message.timestamp);

      const summaries = state.summariesByParent[parentSessionId];
      if (summaries) {
        const target = summaries.find((item) => item.id === sideChatId);
        if (target) {
          target.messageCount = entity.messages.length;
          target.updatedAt = entity.updatedAt;
          state.summariesByParent[parentSessionId] = sortSummaries(summaries);
        }
      }

      if (markUnread && message.type === CoworkSideChatMessageType.Assistant && !message.metadata?.isThinking) {
        state.unreadById[sideChatId] = true;
      }
    },

    updateSideChatMessage(
      state,
      action: PayloadAction<{
        sideChatId: string;
        messageId: string;
        content: string;
        metadata?: Record<string, unknown>;
      }>,
    ) {
      const { sideChatId, messageId, content, metadata } = action.payload;
      const entity = state.entitiesById[sideChatId];
      if (!entity) return;
      const target = entity.messages.find((item) => item.id === messageId);
      if (!target) return;
      target.content = content;
      if (metadata) {
        target.metadata = { ...(target.metadata ?? {}), ...metadata };
      }
    },

    setSideChatStatus(
      state,
      action: PayloadAction<{
        parentSessionId: string;
        sideChatId: string;
        status: CoworkSideChatStatus;
        error?: string | null;
      }>,
    ) {
      const { parentSessionId, sideChatId, status, error } = action.payload;
      const entity = state.entitiesById[sideChatId];
      if (entity) {
        entity.status = status;
        if (error !== undefined) {
          entity.lastError = error;
        } else if (status !== CoworkSideChatStatus.Error) {
          entity.lastError = null;
        }
      }
      const summaries = state.summariesByParent[parentSessionId];
      if (summaries) {
        const target = summaries.find((item) => item.id === sideChatId);
        if (target) {
          target.status = status;
          if (error !== undefined) {
            target.lastError = error;
          } else if (status !== CoworkSideChatStatus.Error) {
            target.lastError = null;
          }
        }
      }
    },

    setSideChatDraft(state, action: PayloadAction<{ sideChatId: string; draft: string }>) {
      state.draftById[action.payload.sideChatId] = action.payload.draft;
    },

    setSideChatSelectedTextSnippets(
      state,
      action: PayloadAction<{ sideChatId: string; snippets: CoworkSelectedTextSnippet[] }>,
    ) {
      state.selectedTextSnippetsById[action.payload.sideChatId] = action.payload.snippets;
    },

    addSideChatAttachment(
      state,
      action: PayloadAction<{ sideChatId: string; attachment: DraftAttachment }>,
    ) {
      const { sideChatId, attachment } = action.payload;
      const existing = state.attachmentsById[sideChatId] ?? [];
      if (existing.some((item) => item.path === attachment.path)) {
        state.attachmentsById[sideChatId] = existing.map((item) => (
          item.path === attachment.path ? attachment : item
        ));
      } else {
        state.attachmentsById[sideChatId] = [...existing, attachment];
      }
    },

    removeSideChatAttachment(
      state,
      action: PayloadAction<{ sideChatId: string; path: string }>,
    ) {
      const { sideChatId, path } = action.payload;
      const existing = state.attachmentsById[sideChatId];
      if (!existing) return;
      state.attachmentsById[sideChatId] = existing.filter((item) => item.path !== path);
    },

    setSideChatModelSelection(
      state,
      action: PayloadAction<{ sideChatId: string; selection: SideChatModelSelection }>,
    ) {
      state.modelSelectionById[action.payload.sideChatId] = action.payload.selection;
    },

    clearSideChatComposer(state, action: PayloadAction<string>) {
      state.draftById[action.payload] = '';
      state.selectedTextSnippetsById[action.payload] = [];
      state.attachmentsById[action.payload] = [];
    },

    addSideChatPermission(state, action: PayloadAction<CoworkSideChatPermissionRequest>) {
      const req = action.payload;
      const list = state.pendingPermissionsById[req.sideChatId] ?? [];
      if (!list.some((item) => item.requestId === req.requestId)) {
        state.pendingPermissionsById[req.sideChatId] = [...list, req];
      }
    },

    resolveSideChatPermission(
      state,
      action: PayloadAction<{ sideChatId: string; requestId: string }>,
    ) {
      const { sideChatId, requestId } = action.payload;
      const list = state.pendingPermissionsById[sideChatId];
      if (!list) return;
      state.pendingPermissionsById[sideChatId] = list.filter((item) => item.requestId !== requestId);
    },
  },
});

export const {
  setSideChatSummaries,
  upsertSideChatSummary,
  setSideChatDetail,
  openSideChatTab,
  setActiveSideChatTab,
  closeSideChatTab,
  removeSideChat,
  clearParentSideChats,
  appendSideChatMessage,
  updateSideChatMessage,
  setSideChatStatus,
  setSideChatDraft,
  setSideChatSelectedTextSnippets,
  addSideChatAttachment,
  removeSideChatAttachment,
  setSideChatModelSelection,
  clearSideChatComposer,
  addSideChatPermission,
  resolveSideChatPermission,
} = sideChatSlice.actions;

export default sideChatSlice.reducer;
