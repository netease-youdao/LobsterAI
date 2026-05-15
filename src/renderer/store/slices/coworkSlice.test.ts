import { expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import coworkReducer, {
  addSession,
  setConfig,
  setCurrentSession,
  setCurrentSessionId,
  setSessions,
  updateCurrentSessionModelOverride,
  updateSessionStatus,
  updateSessionTitle,
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
  thinkingLevel: '',
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

test('addSession preserves the agent id in session summaries', () => {
  const state = coworkReducer(undefined, addSession(makeSession({
    id: 'session-agent-2',
    agentId: 'agent-2',
  })));

  expect(state.sessions[0].agentId).toBe('agent-2');
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
