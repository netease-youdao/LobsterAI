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
  draftPrompt: string;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
}

const initialState: CoworkState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  draftPrompt: '',
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  pendingPermissions: [],
  config: {
    workingDirectory: '',
    systemPrompt: '',
    executionMode: 'local',
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

const clearSessionStreamingFlags = (session: CoworkSession): void => {
  for (const message of session.messages) {
    if (!message.metadata?.isStreaming) {
      continue;
    }
    message.metadata = {
      ...message.metadata,
      isStreaming: false,
    };
  }
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
        if (action.payload.status !== 'running') {
          clearSessionStreamingFlags(action.payload);
        }
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

    setDraftPrompt(state, action: PayloadAction<string>) {
      state.draftPrompt = action.payload;
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
        if (status !== 'running') {
          clearSessionStreamingFlags(state.currentSession);
        }
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
        const messages = state.currentSession.messages;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].id !== messageId) {
            continue;
          }
          if (messages[i].content !== content) {
            messages[i].content = content;
          }
          break;
        }
      }

      markSessionUnread(state, sessionId);
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
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
  addMessage,
  updateMessageContent,
  setStreaming,
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
