import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers, sessionFetchMock } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  sessionFetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  session: {
    defaultSession: {
      fetch: sessionFetchMock,
    },
  },
}));

import {
  DECISION_MODEL_CONFIG_STORE_KEY,
  DecisionModelIpcChannel,
  DecisionModelProvider,
} from '../../../shared/decisionModel/constants';
import {
  type DecisionModelStoreLike,
  registerDecisionModelHandlers,
} from './handlers';

function createMemoryStore(initial: Record<string, unknown> = {}): DecisionModelStoreLike {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

describe('registerDecisionModelHandlers', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    sessionFetchMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('hot-syncs dynamic host tools without restarting DSH when active state flips', async () => {
    const store = createMemoryStore();
    const syncOpenClawConfig = vi.fn(async () => ({ success: true }));
    const setDecisionToolHandler = vi.fn();

    registerDecisionModelHandlers({
      getStore: () => store,
      setDecisionToolHandler,
      syncOpenClawConfig,
    });

    const saveConfig = registeredHandlers.get(DecisionModelIpcChannel.SaveConfig);
    expect(saveConfig).toBeDefined();

    // Turning on with an API key transitions inactive -> active and hot-syncs without restart.
    const enabledView = await saveConfig!({}, {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: 'http://127.0.0.1:41999/v1/systemone',
      apiKey: 'secret-1',
    });
    expect(enabledView).toMatchObject({ enabled: true, active: true });
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'decision-model-toggle',
      restartGatewayIfRunning: false,
    });

    // Updating the API key while still active does not re-sync tool descriptors.
    const updatedView = await saveConfig!({}, { apiKey: 'secret-2' });
    expect(updatedView).toMatchObject({ enabled: true, active: true, apiKey: 'secret-2' });
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(1);

    // Turning off transitions active -> inactive and hot-syncs without restart.
    const disabledView = await saveConfig!({}, { enabled: false });
    expect(disabledView).toMatchObject({ enabled: false, active: false });
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
    expect(syncOpenClawConfig).toHaveBeenLastCalledWith({
      reason: 'decision-model-toggle',
      restartGatewayIfRunning: false,
    });

    expect(store.get(DECISION_MODEL_CONFIG_STORE_KEY)).toMatchObject({
      enabled: false,
      apiKey: 'secret-2',
    });
  });
});
