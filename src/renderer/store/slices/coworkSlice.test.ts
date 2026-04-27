import { expect, test } from 'vitest';

import coworkReducer, { setConfig } from './coworkSlice';

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
    openClawSessionPolicy: {
      keepAlive: '365d',
    },
  }));

  expect(state.config.openClawSessionPolicy.keepAlive).toBe('365d');
});
