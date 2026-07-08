import { expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import coworkReducer, {
  addMessage,
  addSession,
  setConfig,
  setCurrentSession,
  setCurrentSessionId,
  setSessions,
  updateCurrentSessionModelOverride,
  updateMessageContent,
  updateSessionGoal,
  updateSessionStatus,
  updateSessionTitle,
  updateToolUseMediaStatus,
} from './coworkSlice';

const makeSession = (overrides: Partial<Parameters<typeof addSession>[0]> = {}) => ({
  id: 'session-1',
  title: 'Test Session',
  claudeSessionId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local' as const,
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('defaults hidden OpenClaw session policy to thirty days', () => {
  const state = coworkReducer(undefined, { type: 'init' });

  expect(state.config.openClawSessionPolicy).toEqual({
    keepAlive: '30d',
  });
  expect(state.config.skipMissedJobs).toBe(true);
  expect(state.config.openClawHeartbeatEnabled).toBe(true);
});

test('setConfig preserves loaded OpenClaw session policy', () => {
  const state = coworkReducer(undefined, setConfig({
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
    skipMissedJobs: false,
    openClawHeartbeatEnabled: false,
    embeddingEnabled: false,
    embeddingProvider: 'openai',
    embeddingModel: '',
    embeddingLocalModelPath: '',
    embeddingVectorWeight: 0.7,
    embeddingRemoteBaseUrl: '',
    embeddingRemoteApiKey: '',
    dreamingEnabled: false,
    dreamingFrequency: '0 3 * * *',
    dreamingModel: '',
    dreamingTimezone: '',
    openClawSessionPolicy: {
      keepAlive: '365d',
    },
  }));

  expect(state.config.openClawSessionPolicy.keepAlive).toBe('365d');
  expect(state.config.openClawHeartbeatEnabled).toBe(false);
});

test('updateCurrentSessionModelOverride only patches the active session', () => {
  const session = makeSession({ modelOverride: 'openai/gpt-5.4' });

  const activeState = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateCurrentSessionModelOverride({
      sessionId: 'session-1',
      modelOverride: 'lobsterai-server/qwen3.6-plus-YoudaoInner',
    }),
  );

  expect(activeState.currentSession?.modelOverride).toBe('lobsterai-server/qwen3.6-plus-YoudaoInner');
  expect(activeState.currentSession?.updatedAt).toBe(1);

  const ignoredState = coworkReducer(
    activeState,
    updateCurrentSessionModelOverride({
      sessionId: 'session-2',
      modelOverride: 'moonshot/kimi-k2.6',
    }),
  );

  expect(ignoredState.currentSession?.modelOverride).toBe('lobsterai-server/qwen3.6-plus-YoudaoInner');
});

test('updateSessionTitle preserves the session updated time', () => {
  const session = makeSession({ updatedAt: 1000 });
  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateSessionTitle({
      sessionId: 'session-1',
      title: 'Renamed task',
    }),
  );

  expect(state.sessions[0].title).toBe('Renamed task');
  expect(state.sessions[0].updatedAt).toBe(1000);
  expect(state.currentSession?.title).toBe('Renamed task');
  expect(state.currentSession?.updatedAt).toBe(1000);
});

test('updateSessionStatus only refreshes the session updated time on a real transition', () => {
  const initialState = coworkReducer(undefined, setSessions([{
    id: 'session-1',
    title: 'Running task',
    status: CoworkSessionStatusValue.Running,
    pinned: false,
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1000,
  }]));

  const reassertedState = coworkReducer(
    initialState,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Running,
    }),
  );
  expect(reassertedState.sessions[0].updatedAt).toBe(1000);

  const beforeTransition = Date.now();
  const completedState = coworkReducer(
    reassertedState,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );
  expect(completedState.sessions[0].updatedAt).toBeGreaterThanOrEqual(beforeTransition);
});

test('addMessage refreshes the session updated time only for user messages', () => {
  const initialState = coworkReducer(undefined, addSession(makeSession({ updatedAt: 1000 })));

  const streamedState = coworkReducer(
    initialState,
    addMessage({
      sessionId: 'session-1',
      message: { id: 'assistant-1', type: 'assistant', content: 'streamed reply', timestamp: 2000 },
    }),
  );
  expect(streamedState.sessions[0].updatedAt).toBe(1000);
  expect(streamedState.currentSession?.updatedAt).toBe(1000);

  const userState = coworkReducer(
    streamedState,
    addMessage({
      sessionId: 'session-1',
      message: { id: 'user-1', type: 'user', content: 'follow up', timestamp: 3000 },
    }),
  );
  expect(userState.sessions[0].updatedAt).toBe(3000);
  expect(userState.currentSession?.updatedAt).toBe(3000);
});

test('updateMessageContent preserves the session updated time', () => {
  const session = makeSession({
    updatedAt: 1000,
    messages: [{ id: 'assistant-1', type: 'assistant' as const, content: '', timestamp: 900 }],
    totalMessages: 1,
  });
  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateMessageContent({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      content: 'streamed delta',
    }),
  );

  expect(state.sessions[0].updatedAt).toBe(1000);
  expect(state.currentSession?.updatedAt).toBe(1000);
  expect(state.currentSession?.messages[0]?.content).toBe('streamed delta');
});

test('addSession preserves the agent id in session summaries', () => {
  const state = coworkReducer(undefined, addSession(makeSession({
    id: 'session-agent-2',
    agentId: 'agent-2',
  })));

  expect(state.sessions[0].agentId).toBe('agent-2');
});

test('updateSessionGoal updates the current session and session summary', () => {
  const session = makeSession({ updatedAt: 1234 });
  const goal = {
    id: 'goal-1',
    objective: 'Ship goal mode',
    status: 'active' as const,
    createdAt: 100,
    updatedAt: 100,
    tokensUsed: 0,
  };

  const state = coworkReducer(
    coworkReducer(undefined, addSession(session)),
    updateSessionGoal({ sessionId: session.id, goal }),
  );

  expect(state.currentSession?.goal).toEqual(goal);
  expect(state.currentSession?.updatedAt).toBe(1234);
  expect(state.sessions[0].goal).toEqual(goal);
  expect(state.sessions[0].updatedAt).toBe(1234);

  const cleared = coworkReducer(
    state,
    updateSessionGoal({ sessionId: session.id, goal: null }),
  );

  expect(cleared.currentSession?.goal).toBeNull();
  expect(cleared.currentSession?.updatedAt).toBe(1234);
  expect(cleared.sessions[0].goal).toBeNull();
  expect(cleared.sessions[0].updatedAt).toBe(1234);
});

test('setCurrentSession preserves the agent id when inserting a summary', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    id: 'session-agent-3',
    agentId: 'agent-3',
  })));

  expect(state.sessions[0].agentId).toBe('agent-3');
});

test('updateSessionStatus marks completed inactive sessions unread', () => {
  const state = coworkReducer(undefined, setSessions([{
    id: 'session-1',
    title: 'Completed task',
    status: CoworkSessionStatusValue.Running,
    pinned: false,
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  }]));

  const completedState = coworkReducer(
    state,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );

  expect(completedState.unreadSessionIds).toEqual(['session-1']);
});

test('updateSessionStatus does not mark the active completed session unread', () => {
  const state = coworkReducer(
    coworkReducer(undefined, setSessions([{
      id: 'session-1',
      title: 'Active task',
      status: CoworkSessionStatusValue.Running,
      pinned: false,
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
    }])),
    setCurrentSessionId('session-1'),
  );

  const completedState = coworkReducer(
    state,
    updateSessionStatus({
      sessionId: 'session-1',
      status: CoworkSessionStatusValue.Completed,
    }),
  );

  expect(completedState.unreadSessionIds).toEqual([]);
});

test('updateToolUseMediaStatus preserves the highest media poll count', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const highCountState = coworkReducer(state, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 12 },
  }));
  const staleCountState = coworkReducer(highCountState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 1 },
  }));

  expect(staleCountState.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
  });
});

test('updateToolUseMediaStatus drops single media poll counts', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const nextState = coworkReducer(state, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 1 },
  }));

  expect(nextState.currentSession?.messages[0].metadata?.mediaStatusDetails).toEqual({
    taskId: 'task-1',
  });
});

test('updateMessageContent preserves the highest media tool result poll count', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'result-1',
      type: 'tool_result',
      content: 'Task ID: task-1\nStatus: processing',
      timestamp: 1,
      metadata: {
        toolUseId: 'call-1',
        toolResultDetails: { taskId: 'task-1', pollCount: 12, status: 'processing' },
      },
    }],
    totalMessages: 1,
  })));

  const staleCountState = coworkReducer(state, updateMessageContent({
    sessionId: 'session-1',
    messageId: 'result-1',
    content: 'Task ID: task-1\nStatus: processing',
    metadata: {
      toolUseId: 'call-1',
      toolResultDetails: { taskId: 'task-1', pollCount: 1, status: 'processing' },
    },
  }));

  expect(staleCountState.currentSession?.messages[0].metadata?.toolResultDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
    status: 'processing',
  });
});

test('updateMessageContent drops single media tool result poll counts', () => {
  const state = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'result-1',
      type: 'tool_result',
      content: 'Task ID: task-1\nStatus: processing',
      timestamp: 1,
      metadata: {
        toolUseId: 'call-1',
      },
    }],
    totalMessages: 1,
  })));

  const nextState = coworkReducer(state, updateMessageContent({
    sessionId: 'session-1',
    messageId: 'result-1',
    content: 'Task ID: task-1\nStatus: processing',
    metadata: {
      toolUseId: 'call-1',
      toolResultDetails: { taskId: 'task-1', pollCount: 1, status: 'processing' },
    },
  }));

  expect(nextState.currentSession?.messages[0].metadata?.toolResultDetails).toEqual({
    taskId: 'task-1',
    status: 'processing',
  });
});

test('pending media status updates are applied when the tool use arrives', () => {
  const baseState = coworkReducer(undefined, setCurrentSession(makeSession()));
  const pendingState = coworkReducer(baseState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 7 },
  }));

  const state = coworkReducer(pendingState, addMessage({
    sessionId: 'session-1',
    message: {
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 2,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    },
  }));

  expect(state.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 7,
  });
});

test('inactive media status updates are applied when returning to the session', () => {
  const baseState = coworkReducer(undefined, setCurrentSession(makeSession({
    id: 'session-2',
    title: 'Other Session',
  })));

  const pendingState = coworkReducer(baseState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 9 },
  }));

  const state = coworkReducer(pendingState, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 2,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  expect(state.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 9,
  });
});

test('retained media poll counts survive switching away and back', () => {
  const activeState = coworkReducer(undefined, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 1,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  const countedState = coworkReducer(activeState, updateToolUseMediaStatus({
    sessionId: 'session-1',
    toolCallId: 'call-1',
    details: { taskId: 'task-1', pollCount: 12 },
  }));
  const otherSessionState = coworkReducer(countedState, setCurrentSession(makeSession({
    id: 'session-2',
    title: 'Other Session',
  })));
  const returnedState = coworkReducer(otherSessionState, setCurrentSession(makeSession({
    messages: [{
      id: 'tool-1-reloaded',
      type: 'tool_use',
      content: 'Using tool: lobsterai_video_generate',
      timestamp: 3,
      metadata: {
        toolName: 'lobsterai_video_generate',
        toolUseId: 'call-1',
        toolInput: { action: 'status', taskId: 'task-1' },
      },
    }],
    totalMessages: 1,
  })));

  expect(returnedState.currentSession?.messages[0].metadata?.mediaStatusDetails).toMatchObject({
    taskId: 'task-1',
    pollCount: 12,
  });
});
