import { LobsterAIRequestCapability } from '@shared/providers/lobsterAIRequestOptions';
import { ModelThinkingLevel, OpenClawThinkingLevel } from '@shared/providers/modelThinking';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  readRememberedModelThinkingLevel,
  rememberModelThinkingLevel,
  resetModelThinkingLevelMemoryCache,
  resolveThinkingLevelForModel,
} from './modelThinkingLevelMemory';

const STORAGE_KEY = 'lobsterai.model-thinking-levels';
const PRO_KEY = 'lobsterai-server::deepseek-v4-pro';
const FLASH_KEY = 'lobsterai-server::deepseek-v4-flash';

const PRO_MODEL = {
  id: 'deepseek-v4-pro',
  providerKey: 'lobsterai-server',
  isServerModel: true,
  requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
  thinkingConfig: {
    options: [
      { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
      { level: ModelThinkingLevel.Max, openclawLevel: OpenClawThinkingLevel.XHigh },
    ],
    defaultLevel: ModelThinkingLevel.High,
  },
};

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  };
  return store;
}

function readStoredMemory(store: Map<string, string>): unknown {
  return JSON.parse(store.get(STORAGE_KEY) ?? '{}');
}

beforeEach(() => {
  resetModelThinkingLevelMemoryCache();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  resetModelThinkingLevelMemoryCache();
});

test('remembers a thinking level per model instead of one shared level', () => {
  const store = installLocalStorage();

  rememberModelThinkingLevel(PRO_KEY, ModelThinkingLevel.Max);
  rememberModelThinkingLevel(FLASH_KEY, ModelThinkingLevel.Max);
  rememberModelThinkingLevel(FLASH_KEY, ModelThinkingLevel.High);

  expect(readRememberedModelThinkingLevel(PRO_KEY)).toBe(ModelThinkingLevel.Max);
  expect(readRememberedModelThinkingLevel(FLASH_KEY)).toBe(ModelThinkingLevel.High);
  expect(readStoredMemory(store)).toEqual({
    [PRO_KEY]: ModelThinkingLevel.Max,
    [FLASH_KEY]: ModelThinkingLevel.High,
  });
});

test('reloads remembered levels from storage', () => {
  installLocalStorage({
    [STORAGE_KEY]: JSON.stringify({ [PRO_KEY]: ModelThinkingLevel.Max }),
  });

  expect(readRememberedModelThinkingLevel(PRO_KEY)).toBe(ModelThinkingLevel.Max);
});

test('ignores levels that are no longer valid', () => {
  installLocalStorage({
    [STORAGE_KEY]: JSON.stringify({ [PRO_KEY]: 'ultra', [FLASH_KEY]: ModelThinkingLevel.Low }),
  });

  expect(readRememberedModelThinkingLevel(PRO_KEY)).toBeUndefined();
  expect(readRememberedModelThinkingLevel(FLASH_KEY)).toBe(ModelThinkingLevel.Low);
});

test('falls back to no memory when storage is corrupt', () => {
  installLocalStorage({ [STORAGE_KEY]: '{not json' });

  expect(readRememberedModelThinkingLevel(PRO_KEY)).toBeUndefined();
});

test('starts a model on its remembered level instead of the model default', () => {
  installLocalStorage({
    [STORAGE_KEY]: JSON.stringify({ [PRO_KEY]: ModelThinkingLevel.Max }),
  });

  expect(resolveThinkingLevelForModel(PRO_MODEL)).toBe(ModelThinkingLevel.Max);
});

test('starts a model on its default when it has no remembered level', () => {
  installLocalStorage();

  expect(resolveThinkingLevelForModel(PRO_MODEL)).toBe(ModelThinkingLevel.High);
});

test('starts a model on its default when the remembered level is not offered', () => {
  installLocalStorage({
    [STORAGE_KEY]: JSON.stringify({ [PRO_KEY]: ModelThinkingLevel.Off }),
  });

  expect(resolveThinkingLevelForModel(PRO_MODEL)).toBe(ModelThinkingLevel.High);
});

test('resolves no level for models without thinking support', () => {
  installLocalStorage();

  expect(resolveThinkingLevelForModel({ id: 'plain', providerKey: 'custom' })).toBe('');
  expect(resolveThinkingLevelForModel(null)).toBe('');
});

test('resolves no level when the server withdraws request-options support', () => {
  installLocalStorage({
    [STORAGE_KEY]: JSON.stringify({ [PRO_KEY]: ModelThinkingLevel.Max }),
  });

  expect(resolveThinkingLevelForModel({
    ...PRO_MODEL,
    requestCapabilities: undefined,
  })).toBe('');
});

test('stays inert outside a browser window', () => {
  rememberModelThinkingLevel(PRO_KEY, ModelThinkingLevel.Max);

  expect(readRememberedModelThinkingLevel(PRO_KEY)).toBeUndefined();
});
