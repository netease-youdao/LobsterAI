import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkSessionStatusValue } from '../../shared/cowork/constants';
import { ModelPresetId } from '../../shared/modelPresets/constants';
import { ModelContextWindowIpc, type ModelContextWindowMetadata } from '../../shared/providers/modelContextWindow';
import { ModelThinkingLevel } from '../../shared/providers/modelThinking';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkRuntime } from './agentEngine/types';
import { registerModelContextWindowIpc, sessionContextWindowSelection } from './modelContextWindows';

const { metadata } = vi.hoisted(() => ({ metadata: new Map<string, ModelContextWindowMetadata>() }));
vi.mock('./claudeSettings', () => ({ getServerModelMetadata: (id: string) => metadata.get(id) ?? null }));

const createHarness = () => {
  let owner: string | null = 'server:personal:account-a';
  const values = new Map<string, unknown>();
  const set = vi.fn((key: string, value: unknown) => { values.set(key, value); });
  const store = { get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    set, delete: vi.fn((key: string) => values.delete(key)) } as unknown as SqliteStore;
  const session = { id: 'session', modelOverride: 'lobsterai-server/model-a', modelPresetId: null,
    claudeSessionId: 'lobsterai:session', status: CoworkSessionStatusValue.Idle, contextWindowOverride: null,
    contextWindowOwnerKey: null } as CoworkSession;
  const sessions = { getSession: () => session, updateSession: vi.fn((_id: string, update: Partial<CoworkSession>) => Object.assign(session, update)) } as unknown as CoworkStore;
  const patchSession = vi.fn(async () => ({}));
  const runtime = { patchSession, isSessionActive: () => false } as unknown as CoworkRuntime;
  const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const manager = registerModelContextWindowIpc({
    ipcMain: { handle: (key: string, handler: (_event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(key, handler) } as unknown as Electron.IpcMain,
    getStore: () => store, getSessions: () => sessions, getRuntime: () => runtime,
    ownerKey: () => owner, ensureModelsReady: async () => undefined, t: key => key,
  });
  const invoke = (channel: string, request = { modelId: 'model-a', sessionId: session.id }, tokens?: number | null) => handlers.get(channel)!(null, request, tokens);
  return { manager, session, set, values, patchSession, invoke, setOwner: (value: string | null) => { owner = value; } };
};

beforeEach(() => {
  metadata.clear();
  metadata.set('model-a', { contextWindow: 400_000, contextWindowOptions: [400_000, 1_000_000] });
});

describe('explicit context window intent', () => {
  test('context edits and reset leave an existing thinking strength unchanged', async () => {
    const harness = createHarness();
    harness.session.thinkingLevel = ModelThinkingLevel.Max;
    await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000);
    expect(harness.session.thinkingLevel).toBe(ModelThinkingLevel.Max);
    expect(harness.patchSession).toHaveBeenLastCalledWith('session', { contextWindow: 'user-context:1000000' });
    await harness.invoke(ModelContextWindowIpc.Set, undefined, null);
    expect(harness.session.thinkingLevel).toBe(ModelThinkingLevel.Max);
    expect(harness.patchSession).toHaveBeenLastCalledWith('session', { contextWindow: null });
  });

  test('reads follow server changes without persisting any preference', async () => {
    const harness = createHarness();
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ success: true, data: { override: null, defaultWindow: 400_000 } });
    metadata.get('model-a')!.contextWindow = 600_000;
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ success: true, data: { override: null, defaultWindow: 600_000 } });
    expect(harness.set).not.toHaveBeenCalled();
    expect(harness.values.size).toBe(0);
  });

  test('saves only after a successful explicit patch, then restores on a new session', async () => {
    const harness = createHarness();
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000)).toMatchObject({ success: true, data: { override: 1_000_000 } });
    expect(harness.patchSession).toHaveBeenCalledWith('session', { contextWindow: 'user-context:1000000' });
    metadata.get('model-a')!.contextWindow = 500_000;
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ data: { override: 1_000_000, defaultWindow: 500_000 } });
    harness.session.contextWindowOverride = null;
    harness.manager.restoreForSession('session');
    expect(harness.session.contextWindowOverride).toBe(1_000_000);
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, null)).toMatchObject({ success: true, data: { override: null } });
    expect(harness.values.size).toBe(0);
    harness.manager.restoreForSession('session');
    expect(harness.session.contextWindowOverride).toBeNull();
  });

  test('opening another historical session does not inherit a newly saved preference', async () => {
    const harness = createHarness();
    await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000);
    harness.session.contextWindowOverride = null;
    harness.session.contextWindowOwnerKey = null;
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ data: { override: null } });
  });

  test('failed or unavailable selections never write session or preference intent', async () => {
    const harness = createHarness();
    harness.patchSession.mockRejectedValueOnce(new Error('gateway unavailable'));
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000)).toMatchObject({ success: false });
    expect(harness.session.contextWindowOverride).toBeNull();
    expect(harness.set).not.toHaveBeenCalled();
    metadata.get('model-a')!.contextWindowOptions = undefined;
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000)).toMatchObject({ success: false });
    expect(harness.values.size).toBe(0);
  });

  test('a fixed 400K remains explicit when the default changes; accounts and enterprises do not share it', async () => {
    const harness = createHarness();
    await harness.invoke(ModelContextWindowIpc.Set, undefined, 400_000);
    metadata.get('model-a')!.contextWindow = 800_000;
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ data: { override: 400_000 } });
    harness.setOwner('server:enterprise:account-a:42');
    expect(await harness.invoke(ModelContextWindowIpc.Get)).toMatchObject({ data: { override: null } });
    harness.manager.restoreForSession('session');
    expect(harness.session.contextWindowOverride).toBeNull();
  });

  test('restoring a mode default preserves the mode budget and does not select a different model', async () => {
    const harness = createHarness();
    harness.session.modelPresetId = ModelPresetId.Balanced;
    Object.assign(metadata.get('model-a')!, { contextWindow: 1_000_000,
      presetContextWindows: { [ModelPresetId.Balanced]: 450_000 },
      presetContextWindowOptions: { [ModelPresetId.Balanced]: [400_000, 1_000_000] } });
    const request = { modelId: 'yd-fast', presetId: ModelPresetId.Balanced, sessionId: 'session' };
    expect(await harness.invoke(ModelContextWindowIpc.Set, request, 1_000_000)).toMatchObject({ success: true });
    expect(sessionContextWindowSelection(harness.session, metadata.get('model-a')!, harness.session.contextWindowOwnerKey!)).toBe('user-context:yd-fast:1000000');
    await harness.invoke(ModelContextWindowIpc.Set, request, null);
    expect(harness.patchSession).toHaveBeenLastCalledWith('session', { contextWindow: 'yd-fast' });
    expect(harness.session.modelOverride).toBe('lobsterai-server/model-a');
  });

  test('running sessions and absent login cannot persist a choice', async () => {
    const harness = createHarness();
    harness.session.status = CoworkSessionStatusValue.Running;
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000)).toMatchObject({ success: false });
    harness.session.status = CoworkSessionStatusValue.Idle;
    harness.setOwner(null);
    expect(await harness.invoke(ModelContextWindowIpc.Set, undefined, 1_000_000)).toMatchObject({ success: false });
    expect(harness.values.size).toBe(0);
  });
});
