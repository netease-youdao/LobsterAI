import { describe, expect, test, vi } from 'vitest';

import { DSH_SESSION_ID_PREFIX } from '../../shared/dshEngine/hostConstants';
import { ModelPresetId, ModelPresetIpc, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat, ModelThinkingLevel, OpenClawThinkingLevel } from '../../shared/providers';
import { getServerModelMetadata } from './claudeSettings';
import { createModelPresetClient, registerModelPresetIpc } from './modelPresets';

vi.mock('./claudeSettings', () => ({ getServerModelMetadata: vi.fn(), resolveRawApiConfig: vi.fn() }));

const response = () => Response.json({ code: 0, data: { modelId: 'resolved-model', apiFormat: ApiFormat.OpenAI } });
const clientFor = (fetchWithAuth: typeof fetch, isAccountCurrent = () => () => true) => createModelPresetClient({
  fetchWithAuth, serverBaseUrl: () => 'https://server.example', headers: () => ({ 'X-Test-Capability': 'models' }), isAccountCurrent,
});

describe('model preset resolve transport', () => {
  test.each(Object.values(ModelPresetId))('uses the existing authenticated resolve endpoint for %s', async presetId => {
    const fetchWithAuth = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const signal = new AbortController().signal;
    await clientFor(fetchWithAuth).resolve('transient-request', presetId, false, signal);
    expect(fetchWithAuth).toHaveBeenCalledWith(`https://server.example/api/models/${modelPresetModelId(presetId)}/resolve`, {
      method: 'POST', headers: { 'X-Test-Capability': 'models', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'transient-request', requiresImage: false }), signal,
    });
  });

  test('keeps shared chat requests separate from independently cancellable quick answers', async () => {
    const fetchWithAuth = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const client = clientFor(fetchWithAuth);
    const first = client.resolve('same-id', ModelPresetId.Balanced, false);
    expect(client.resolve('same-id', ModelPresetId.Balanced, false)).toBe(first);
    const controller = new AbortController();
    const separate = client.resolve('same-id', ModelPresetId.Balanced, false, controller.signal);
    const rejected = expect(separate).rejects.toThrow();
    controller.abort();
    await rejected;
    await expect(first).resolves.toMatchObject({ modelId: 'resolved-model' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  test('rejects a response after the account changes', async () => {
    let current = true;
    let release!: (value: Response) => void;
    const client = clientFor(() => new Promise(resolve => { release = resolve; }), () => () => current);
    const pending = client.resolve('transient-request', ModelPresetId.Ultimate, false, new AbortController().signal);
    current = false;
    release(response());
    await expect(pending).rejects.toThrow('Account changed');
  });
});

describe('registerModelPresetIpc thinkingLevel forwarding', () => {
  test('forwards requested thinkingLevel in choose() and SelectSession instead of dropping to defaultLevel', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
    } as unknown as import('electron').IpcMain;

    const sessionState: Record<string, unknown> = {
      id: 'sess-1',
      agentId: 'main',
      status: 'idle',
      modelOverride: '',
      modelPresetId: null,
      thinkingLevel: '',
      messages: [],
    };
    const updateSession = vi.fn((_sid: string, updates: Record<string, unknown>) => {
      Object.assign(sessionState, updates);
    });
    const patchSession = vi.fn(async (_sid: string, patch: { model?: string; thinkingLevel?: string | null }) => ({
      modelOverride: patch.model,
      resolvedModelRef: patch.model,
      thinkingLevel: patch.thinkingLevel ?? undefined,
    }));

    const client = {
      available: vi.fn(async () => []),
      resolve: vi.fn(async () => ({
        modelId: 'glm-5.3',
        apiFormat: ApiFormat.OpenAI,
        thinkingConfig: {
          defaultLevel: ModelThinkingLevel.Medium,
          options: [
            { level: ModelThinkingLevel.Low, openclawLevel: OpenClawThinkingLevel.Low },
            { level: ModelThinkingLevel.Medium, openclawLevel: OpenClawThinkingLevel.Medium },
            { level: ModelThinkingLevel.High, openclawLevel: OpenClawThinkingLevel.High },
          ],
        },
      })),
    };

    const { choose } = registerModelPresetIpc({
      ipcMain,
      client: client as unknown as ReturnType<typeof createModelPresetClient>,
      getStore: () => ({ get: () => undefined, set: vi.fn() }) as unknown as import('../sqliteStore').SqliteStore,
      getSessions: () => ({
        getSession: () => sessionState,
        getLatestUserMessage: () => null,
        updateSession,
        addMessage: vi.fn(),
      }) as unknown as import('../coworkStore').CoworkStore,
      getRuntime: () => ({
        isSessionActive: () => false,
        patchSession,
      }) as unknown as import('./agentEngine/types').CoworkRuntime,
      ownerAccountKey: () => 'acct-1',
      ensureModelsReady: async () => undefined,
      isAccountCurrent: () => () => true,
      t: (k) => k,
    });

    // 1. Direct choose(..., initial = true, thinkingLevel = 'high') preserves 'high'
    const initialSession = await choose('sess-1', ModelPresetId.Balanced, false, true, ModelThinkingLevel.High);
    expect(initialSession.thinkingLevel).toBe(ModelThinkingLevel.High);
    expect(updateSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ thinkingLevel: ModelThinkingLevel.High }),
      { touchUpdatedAt: false },
    );

    // 2. SelectSession IPC with 'low' forwards 'low' to patchSession & store
    const selectHandler = handlers.get(ModelPresetIpc.SelectSession)!;
    const ipcRes = await selectHandler({}, 'sess-1', ModelPresetId.Ultimate, ModelThinkingLevel.Low) as {
      success: boolean;
      data?: { thinkingLevel?: string };
    };
    expect(ipcRes.success).toBe(true);
    expect(patchSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      model: 'lobsterai-server/glm-5.3',
      thinkingLevel: ModelThinkingLevel.Low,
    }));
    expect(sessionState.thinkingLevel).toBe(ModelThinkingLevel.Low);

    // 3. Unsupported level ('max' not in options) falls back to config.defaultLevel ('medium')
    await selectHandler({}, 'sess-1', ModelPresetId.Balanced, ModelThinkingLevel.Max);
    expect(patchSession).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      thinkingLevel: ModelThinkingLevel.Medium,
    }));

    // 4. DSH native desktop chat session allows switching to a preset
    sessionState.claudeSessionId = `${DSH_SESSION_ID_PREFIX}session-123`;
    sessionState.modelPresetId = null;
    sessionState.imPlatform = null;
    const dshRes = await selectHandler({}, 'sess-1', ModelPresetId.Ultimate, undefined) as {
      success: boolean;
      data?: { modelPresetId?: string | null };
    };
    expect(dshRes.success).toBe(true);
    expect(dshRes.data?.modelPresetId).toBe(ModelPresetId.Ultimate);

    // 5. DSH IM session can switch presets without inheriting desktop context window preferences
    vi.mocked(getServerModelMetadata).mockReturnValue({
      contextWindow: 400_000,
      contextWindowOptions: [400_000, 1_000_000],
      presetContextWindows: { [ModelPresetId.Balanced]: 400_000 },
      presetContextWindowOptions: { [ModelPresetId.Balanced]: [400_000, 1_000_000] },
    });
    const kvStore = new Map<string, unknown>([
      ['model_context_windows:owner-1', { [modelPresetModelId(ModelPresetId.Balanced)]: 1_000_000 }],
    ]);
    const imHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const imPatchSession = vi.fn(async (_sid: string, patch: { model?: string; thinkingLevel?: string | null; contextWindow?: string | null }) => ({
      modelOverride: patch.model,
      resolvedModelRef: patch.model,
      thinkingLevel: patch.thinkingLevel ?? undefined,
    }));
    registerModelPresetIpc({
      ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          imHandlers.set(channel, handler);
        }),
      } as unknown as import('electron').IpcMain,
      client: client as unknown as ReturnType<typeof createModelPresetClient>,
      getStore: () => ({ get: (key: string) => kvStore.get(key), set: vi.fn() }) as unknown as import('../sqliteStore').SqliteStore,
      getSessions: () => ({
        getSession: () => sessionState,
        getLatestUserMessage: () => null,
        updateSession,
        addMessage: vi.fn(),
      }) as unknown as import('../coworkStore').CoworkStore,
      getRuntime: () => ({
        isSessionActive: () => false,
        patchSession: imPatchSession,
      }) as unknown as import('./agentEngine/types').CoworkRuntime,
      ownerAccountKey: () => 'acct-1',
      contextWindowOwnerKey: () => 'owner-1',
      ensureModelsReady: async () => undefined,
      isAccountCurrent: () => () => true,
      t: (k) => k,
    });
    const imSelectHandler = imHandlers.get(ModelPresetIpc.SelectSession)!;

    // Desktop session inherits the remembered desktop 1M context window preference.
    sessionState.imPlatform = null;
    sessionState.modelPresetId = null;
    sessionState.contextWindowOverride = null;
    sessionState.contextWindowOwnerKey = null;
    const desktopCtxRes = await imSelectHandler({}, 'sess-1', ModelPresetId.Balanced, undefined) as {
      success: boolean;
      data?: { modelPresetId?: string | null; contextWindowOverride?: number | null };
    };
    expect(desktopCtxRes.success).toBe(true);
    expect(desktopCtxRes.data?.modelPresetId).toBe(ModelPresetId.Balanced);
    expect(desktopCtxRes.data?.contextWindowOverride).toBe(1_000_000);
    expect(imPatchSession).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      model: 'lobsterai-server/glm-5.3',
      contextWindow: 'user-context:yd-fast:1000000',
    }));

    // IM session switches to the preset, using only the preset default context window.
    sessionState.imPlatform = 'feishu';
    sessionState.modelPresetId = null;
    sessionState.contextWindowOverride = 1_000_000;
    sessionState.contextWindowOwnerKey = 'owner-1';
    const imRes = await imSelectHandler({}, 'sess-1', ModelPresetId.Balanced, undefined) as {
      success: boolean;
      data?: { modelPresetId?: string | null; contextWindowOverride?: number | null; contextWindowOwnerKey?: string | null };
    };
    expect(imRes.success).toBe(true);
    expect(imRes.data?.modelPresetId).toBe(ModelPresetId.Balanced);
    expect(imRes.data?.contextWindowOverride).toBeNull();
    expect(imRes.data?.contextWindowOwnerKey).toBeNull();
    expect(imPatchSession).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      model: 'lobsterai-server/glm-5.3',
      contextWindow: modelPresetModelId(ModelPresetId.Balanced),
    }));
  });
});
