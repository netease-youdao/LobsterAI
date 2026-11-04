import { describe, expect, test, vi } from 'vitest';

import { CoworkSystemMessageKind } from '../../common/coworkSystemMessages';
import { ModelPresetId } from '../../shared/modelPresets/constants';
import type { CoworkMessage, CoworkSession, CoworkStore } from '../coworkStore';
import { recordSessionModelChange } from './sessionModelChange';

vi.mock('./claudeSettings', () => ({ resolveRawApiConfig: () => ({ config: null }) }));

const AgentDefaultModel = 'lobsterai-server/yd-fast';

const createStore = () => {
  const added: CoworkMessage[] = [];
  const store = {
    getAgent: () => ({ model: AgentDefaultModel }),
    getLatestUserMessage: () => ({ id: 'user-1' }),
    deleteMessage: vi.fn(),
    addMessage: (_sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>) => {
      added.push({ ...message, id: `notice-${added.length + 1}`, timestamp: 1 } as CoworkMessage);
    },
    getSession: () => null,
  } as unknown as CoworkStore;
  return { store, added };
};

const session = (patch: Partial<CoworkSession>): CoworkSession => ({
  id: 'session-1',
  agentId: 'main',
  modelOverride: '',
  modelPresetId: null,
  messages: [],
  ...patch,
} as CoworkSession);

describe('recordSessionModelChange', () => {
  test('records an agent-default preset model as that preset', () => {
    const { store, added } = createStore();

    recordSessionModelChange(
      store,
      session({}),
      session({ modelOverride: 'lobsterai-server/deepseek-v4-flash-inhouse-YoudaoInner' }),
    );

    expect(added).toHaveLength(1);
    expect(added[0].metadata?.kind).toBe(CoworkSystemMessageKind.ModelChanged);
    expect(added[0].metadata?.modelChange).toMatchObject({
      previousModelRef: AgentDefaultModel,
      previousPresetId: ModelPresetId.Balanced,
      nextPresetId: null,
    });
  });

  test('does not record choosing the preset the agent default already uses', () => {
    const { store, added } = createStore();

    recordSessionModelChange(
      store,
      session({}),
      session({
        modelOverride: 'lobsterai-server/deepseek-flash-YoudaoInner',
        modelPresetId: ModelPresetId.Balanced,
      }),
    );

    expect(added).toEqual([]);
  });
});
