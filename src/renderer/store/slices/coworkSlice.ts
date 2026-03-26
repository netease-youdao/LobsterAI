import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkMessage,
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkSessionStatus,
} from '../../types/cowork';

interface CoworkState {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  draftPrompts: Record<string, string>;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  remoteManaged: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
}

const initialState: CoworkState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  draftPrompts: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  remoteManaged: false,
  pendingPermissions: [],
  config: {
    workingDirectory: '',
    systemPrompt: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
  },
};

const markSessionRead = (state: CoworkState, sessionId: string | null) => {
  if (!sessionId) return;
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
};

const markSessionUnread = (state: CoworkState, sessionId: string) => {
  if (state.currentSessionId === sessionId) return;
  if (state.unreadSessionIds.includes(sessionId)) return;
  state.unreadSessionIds.push(sessionId);
};

const STREAMING_MERGE_PROBE_CHARS = 512;

const computeStreamingSuffixPrefixOverlap = (left: string, right: string): number => {
  const leftProbe = left.slice(-STREAMING_MERGE_PROBE_CHARS);
  const rightProbe = right.slice(0, STREAMING_MERGE_PROBE_CHARS);
  const maxOverlap = Math.min(leftProbe.length, rightProbe.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftProbe.slice(-size) === rightProbe.slice(0, size)) {
      return size;
    }
  }
  return 0;
};

const mergeStreamingMessageContent = (previousContent: string, incomingContent: string): string => {
  if (!incomingContent) return previousContent;
  if (!previousContent) return incomingContent;
  if (incomingContent === previousContent) return previousContent;

  // Snapshot mode: upstream sends full content each update.
  if (incomingContent.startsWith(previousContent)) {
    return incomingContent;
  }

  // Guard against temporary partial rollback chunks.
  if (previousContent.startsWith(incomingContent)) {
    return previousContent;
  }

  // Another snapshot pattern where previous content is fully contained.
  if (incomingContent.includes(previousContent) && incomingContent.length > previousContent.length) {
    return incomingContent;
  }

  // Delta mode: append the non-overlapping tail.
  const overlap = computeStreamingSuffixPrefixOverlap(previousContent, incomingContent);
  return previousContent + incomingContent.slice(overlap);
};

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      state.sessions = action.payload;
      const validSessionIds = new Set(action.payload.map((session) => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      state.currentSession = action.payload;
      if (action.payload) {
        state.currentSessionId = action.payload.id;
        if (!action.payload.id.startsWith('temp-')) {
          const { id, title, status, pinned, createdAt, updatedAt } = action.payload;
          const summary: CoworkSessionSummary = {
            id,
            title,
            status,
            pinned: pinned ?? false,
            createdAt,
            updatedAt,
          };
          const sessionIndex = state.sessions.findIndex((session) => session.id === id);
          if (sessionIndex !== -1) {
            state.sessions[sessionIndex] = {
              ...state.sessions[sessionIndex],
              ...summary,
            };
          } else {
            state.sessions.unshift(summary);
          }
        }
        markSessionRead(state, action.payload.id);
      }
    },

    setDraftPrompt(state, action: PayloadAction<{ sessionId: string; draft: string }>) {
      const { sessionId, draft } = action.payload;
      if (draft) {
        state.draftPrompts[sessionId] = draft;
      } else {
        delete state.draftPrompts[sessionId];
      }
    },

    addSession(state, action: PayloadAction<CoworkSession>) {
      const summary: CoworkSessionSummary = {
        id: action.payload.id,
        title: action.payload.title,
        status: action.payload.status,
        pinned: action.payload.pinned ?? false,
        createdAt: action.payload.createdAt,
        updatedAt: action.payload.updatedAt,
      };
      state.sessions.unshift(summary);
      state.currentSession = action.payload;
      state.currentSessionId = action.payload.id;
      markSessionRead(state, action.payload.id);
    },

    updateSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        state.currentSession.updatedAt = Date.now();
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === 'running';
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      const sessionId = action.payload;
      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);

      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        state.currentSession = null;
      }
    },

    deleteSessions(state, action: PayloadAction<string[]>) {
      const sessionIds = new Set(action.payload);
      state.sessions = state.sessions.filter(s => !sessionIds.has(s.id));
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => !sessionIds.has(id));

      if (state.currentSessionId && sessionIds.has(state.currentSessionId)) {
        state.currentSessionId = null;
        state.currentSession = null;
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some((item) => item.id === message.id);
        if (!exists) {
          state.currentSession.messages.push(message);
          state.currentSession.updatedAt = message.timestamp;
        }
      }

      // Update session in list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].updatedAt = message.timestamp;
      }

      markSessionUnread(state, sessionId);
    },

    updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content: string }>) {
      const { sessionId, messageId, content } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          const previousContent = state.currentSession.messages[messageIndex].content || '';
          if (state.config.agentEngine === 'yd_cowork') {
            state.currentSession.messages[messageIndex].content = mergeStreamingMessageContent(previousContent, content);
          } else {
            state.currentSession.messages[messageIndex].content = content;
          }
        }
      }

      markSessionUnread(state, sessionId);
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    setRemoteManaged(state, action: PayloadAction<boolean>) {
      state.remoteManaged = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean }>) {
      const { sessionId, pinned } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].pinned = pinned;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.pinned = pinned;
      }
    },

    updateSessionTitle(state, action: PayloadAction<{ sessionId: string; title: string }>) {
      const { sessionId, title } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].title = title;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
        state.currentSession.updatedAt = Date.now();
      }
    },

    enqueuePendingPermission(state, action: PayloadAction<CoworkPermissionRequest>) {
      const alreadyQueued = state.pendingPermissions.some(
        (permission) => permission.requestId === action.payload.requestId
      );
      if (alreadyQueued) return;
      state.pendingPermissions.push(action.payload);
    },

    dequeuePendingPermission(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingPermissions.shift();
        return;
      }
      state.pendingPermissions = state.pendingPermissions.filter(
        (permission) => permission.requestId !== requestId
      );
    },

    clearPendingPermissions(state) {
      state.pendingPermissions = [];
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    clearCurrentSession(state) {
      state.currentSessionId = null;
      state.currentSession = null;
      state.isStreaming = false;
      state.remoteManaged = false;
    },
  },
});

export const {
  setCoworkActive,
  setSessions,
  setCurrentSessionId,
  setCurrentSession,
  setDraftPrompt,
  addSession,
  updateSessionStatus,
  deleteSession,
  deleteSessions,
  addMessage,
  updateMessageContent,
  setStreaming,
  setRemoteManaged,
  updateSessionPinned,
  updateSessionTitle,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
} = coworkSlice.actions;

export default coworkSlice.reducer;
