import { ModelPresetId } from '@shared/modelPresets/constants';
import { ProviderName } from '@shared/providers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkSystemMessageKind } from '../../../common/coworkSystemMessages';
import { i18nService } from '../../services/i18n';
import { modelPresetName } from '../../services/modelPresets';
import type { Model } from '../../store/slices/modelSlice';
import { type CoworkSession, CoworkSessionStatusValue } from '../../types/cowork';
import {
  isModelSwitchConfirmSkipped,
  MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY,
  resolveModelSwitchConfirmation,
  setModelSwitchConfirmSkipped,
} from './modelSwitchConfirm';

const flashModel: Model = {
  id: 'deepseek-flash-YoudaoInner',
  name: 'DeepSeek Flash',
  providerKey: ProviderName.LobsteraiServer,
  isServerModel: true,
  accessible: true,
};

const proModel: Model = {
  id: 'deepseek-pro-YoudaoInner',
  name: 'DeepSeek Pro',
  providerKey: ProviderName.LobsteraiServer,
  isServerModel: true,
  accessible: true,
};

const customModel: Model = {
  id: 'claude-opus-4',
  name: 'Opus 4',
  providerKey: ProviderName.Anthropic,
};

const fastPreset: Model = {
  id: 'yd-fast',
  name: 'Fast',
  presetId: ModelPresetId.Balanced,
  providerKey: ProviderName.LobsteraiServer,
  isServerModel: true,
  accessible: true,
};

const flagshipPreset: Model = {
  id: 'yd-ultra',
  name: 'Flagship',
  presetId: ModelPresetId.Ultimate,
  providerKey: ProviderName.LobsteraiServer,
  isServerModel: true,
  accessible: true,
};

const availableModels = [fastPreset, flagshipPreset, flashModel, proModel, customModel];

function makeSession(patch: Partial<CoworkSession> = {}): CoworkSession {
  return {
    id: 'session-1',
    title: 'Test session',
    agentId: 'main',
    modelOverride: `${ProviderName.LobsteraiServer}/${flashModel.id}`,
    modelPresetId: null,
    claudeSessionId: null,
    scheduledTaskId: null,
    status: CoworkSessionStatusValue.Completed,
    pinned: false,
    cwd: '',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [
      { id: 'u1', type: 'user', content: 'Hello', timestamp: 1 },
      { id: 'a1', type: 'assistant', content: 'Hi there', timestamp: 2 },
    ],
    messagesOffset: 0,
    totalMessages: 2,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as Storage;
  vi.stubGlobal('window', { localStorage });
  return store;
}

beforeEach(() => {
  i18nService.setLanguage('zh', { persist: false });
  installLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model switch confirmation preference storage', () => {
  test('defaults to false and persists opt-out in localStorage', () => {
    const store = installLocalStorage();
    expect(isModelSwitchConfirmSkipped()).toBe(false);

    setModelSwitchConfirmSkipped(true);
    expect(store.get(MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY)).toBe('1');
    expect(isModelSwitchConfirmSkipped()).toBe(true);

    setModelSwitchConfirmSkipped(false);
    expect(store.has(MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY)).toBe(false);
    expect(isModelSwitchConfirmSkipped()).toBe(false);
  });

  test('fails safely when localStorage is absent or throws', () => {
    vi.stubGlobal('window', {});
    expect(isModelSwitchConfirmSkipped()).toBe(false);
    expect(() => setModelSwitchConfirmSkipped(true)).not.toThrow();

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      },
    });
    expect(isModelSwitchConfirmSkipped()).toBe(false);
    expect(() => setModelSwitchConfirmSkipped(true)).not.toThrow();
  });
});

describe('resolveModelSwitchConfirmation', () => {
  test('returns cached and next display names for a mid-conversation concrete model switch', () => {
    const result = resolveModelSwitchConfirmation({
      session: makeSession(),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: proModel,
      sessionModelIsInvalid: false,
    });

    expect(result).toEqual({
      previousModelName: 'DeepSeek Flash',
      nextModelName: 'DeepSeek Pro',
    });
  });

  test('returns localized preset names when switching between presets', () => {
    const result = resolveModelSwitchConfirmation({
      session: makeSession({
        modelOverride: `${ProviderName.LobsteraiServer}/${flashModel.id}`,
        modelPresetId: ModelPresetId.Balanced,
      }),
      availableModels,
      currentEffectiveModel: fastPreset,
      nextModel: flagshipPreset,
      sessionModelIsInvalid: false,
    });

    expect(result).toEqual({
      previousModelName: modelPresetName(ModelPresetId.Balanced),
      nextModelName: modelPresetName(ModelPresetId.Ultimate),
    });
  });

  test('prompts when conversation history is before the loaded message window', () => {
    const result = resolveModelSwitchConfirmation({
      session: makeSession({
        messages: [{ id: 'a9', type: 'assistant', content: 'Long turn tail', timestamp: 9 }],
        messagesOffset: 10,
        totalMessages: 11,
      }),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: customModel,
      sessionModelIsInvalid: false,
    });

    expect(result).toEqual({
      previousModelName: 'DeepSeek Flash',
      nextModelName: 'Opus 4',
    });
  });

  test('skips confirmation when session has no user messages yet', () => {
    const result = resolveModelSwitchConfirmation({
      session: makeSession({
        messages: [{ id: 'welcome', type: 'assistant', content: 'Welcome', timestamp: 1 }],
        messagesOffset: 0,
        totalMessages: 1,
      }),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: proModel,
      sessionModelIsInvalid: false,
    });

    expect(result).toBeNull();
  });

  test('skips confirmation for same-model selection, thinking-only updates, invalid recovery, and persisted opt-out', () => {
    expect(resolveModelSwitchConfirmation({
      session: makeSession(),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: flashModel,
      sessionModelIsInvalid: false,
    })).toBeNull();

    expect(resolveModelSwitchConfirmation({
      session: makeSession(),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: proModel,
      sessionModelIsInvalid: false,
      thinkingOnly: true,
    })).toBeNull();

    expect(resolveModelSwitchConfirmation({
      session: makeSession(),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: proModel,
      sessionModelIsInvalid: true,
    })).toBeNull();

    setModelSwitchConfirmSkipped(true);
    expect(resolveModelSwitchConfirmation({
      session: makeSession(),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: proModel,
      sessionModelIsInvalid: false,
    })).toBeNull();
  });

  test('uses the original cached model when switching again before sending a message, and skips when reverting to it', () => {
    const pendingSession = makeSession({
      modelOverride: `${ProviderName.LobsteraiServer}/${proModel.id}`,
      messages: [
        { id: 'u1', type: 'user', content: 'Hello', timestamp: 1 },
        { id: 'a1', type: 'assistant', content: 'Hi', timestamp: 2 },
        {
          id: 'mc1',
          type: 'system',
          content: '',
          timestamp: 3,
          metadata: {
            kind: CoworkSystemMessageKind.ModelChanged,
            modelChange: {
              previousModelRef: `${ProviderName.LobsteraiServer}/${flashModel.id}`,
              nextModelRef: `${ProviderName.LobsteraiServer}/${proModel.id}`,
              previousPresetId: null,
              nextPresetId: null,
            },
          },
        },
      ],
    });

    // Reverting to the cached model cancels the pending switch without busting cache.
    expect(resolveModelSwitchConfirmation({
      session: pendingSession,
      availableModels,
      currentEffectiveModel: proModel,
      nextModel: flashModel,
      sessionModelIsInvalid: false,
    })).toBeNull();

    // Switching to a third model still reports the original cached model.
    expect(resolveModelSwitchConfirmation({
      session: pendingSession,
      availableModels,
      currentEffectiveModel: proModel,
      nextModel: customModel,
      sessionModelIsInvalid: false,
    })).toEqual({
      previousModelName: 'DeepSeek Flash',
      nextModelName: 'Opus 4',
    });
  });

  test('falls back to effective model when session has no explicit modelOverride yet', () => {
    const result = resolveModelSwitchConfirmation({
      session: makeSession({ modelOverride: '', modelPresetId: null }),
      availableModels,
      currentEffectiveModel: flashModel,
      nextModel: customModel,
      sessionModelIsInvalid: false,
    });

    expect(result).toEqual({
      previousModelName: 'DeepSeek Flash',
      nextModelName: 'Opus 4',
    });
  });
});
