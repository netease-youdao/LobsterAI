import { type AvailableModelPreset, isChatPresetSession, type ModelPresetId, ModelPresetIpc, modelPresetPreferenceKey, parseModelPresetId, parseModelPresetPreference } from '../../shared/modelPresets/constants';
import { type ModelThinkingLevel, OpenClawProviderId, parseModelThinkingConfig, parseModelThinkingLevel } from '../../shared/providers';
import type { ServerModelMetadataInput } from './claudeSettings';

export type ResolvedPresetModel = ServerModelMetadataInput & { modelId: string; apiFormat: string; accessible?: boolean };

type Dependencies = {
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  serverBaseUrl: () => string;
  headers: () => Record<string, string>;
  isAccountCurrent: () => () => boolean;
};

/** Resolve once before a chat run; the caller persists the real model before starting it. */
export function createModelPresetClient(dependencies: Dependencies) {
  const pending = new Map<string, Promise<ResolvedPresetModel>>();
  return {
    async available(): Promise<AvailableModelPreset[]> {
      const isCurrent = dependencies.isAccountCurrent();
      const response = await dependencies.fetchWithAuth(`${dependencies.serverBaseUrl()}/api/model-presets/available`, {
        headers: dependencies.headers(),
      });
      if (!isCurrent()) throw new Error('Account changed while loading model presets');
      if (response.status === 404) return []; // Older servers keep their ordinary model catalog.
      const body = await response.json() as { code: number; data?: AvailableModelPreset[]; message?: string };
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data)) throw new Error(body.message || 'Failed to load model presets');
      if (!isCurrent()) throw new Error('Account changed while loading model presets');
      return body.data.filter(preset => parseModelPresetId(preset.presetId));
    },
    resolve(sessionId: string, presetId: ModelPresetId, requiresImage: boolean): Promise<ResolvedPresetModel> {
      const key = `${sessionId}:${presetId}:${requiresImage}`;
      const existing = pending.get(key);
      if (existing) return existing;
      const isCurrent = dependencies.isAccountCurrent();
      const request = (async () => {
        const response = await dependencies.fetchWithAuth(`${dependencies.serverBaseUrl()}/api/model-presets/${presetId}/resolve`, {
          method: 'POST',
          headers: { ...dependencies.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, requiresImage }),
        });
        const body = await response.json() as { code: number; data?: ResolvedPresetModel; message?: string };
        if (!isCurrent()) throw new Error('Account changed while resolving model preset');
        if (!response.ok || body.code !== 0 || !body.data?.modelId || body.data.accessible === false
          || !['openai', 'anthropic'].includes(body.data.apiFormat)) {
          throw new Error(body.message || 'Failed to resolve model preset');
        }
        return body.data;
      })();
      pending.set(key, request);
      void request.finally(() => { if (pending.get(key) === request) pending.delete(key); }).catch((): void => {});
      return request;
    },
  };
}

export function registerModelPresetIpc(dependencies: {
  ipcMain: import('electron').IpcMain;
  client: ReturnType<typeof createModelPresetClient>;
  getStore: () => import('../sqliteStore').SqliteStore;
  getSessions: () => import('../coworkStore').CoworkStore;
  getRuntime: () => import('./agentEngine/types').CoworkRuntime;
  ownerAccountKey: () => string | null;
  ensureModelsReady: () => Promise<unknown>;
  isAccountCurrent: () => () => boolean;
  t: (key: string) => string;
}) {
  const { ipcMain, client, getSessions, t } = dependencies;
  const selectionRevision = new Map<string, number>();
  const selections = new Map<string, Promise<import('../coworkStore').CoworkSession>>();
  const preferenceKey = () => {
    const owner = dependencies.ownerAccountKey();
    if (!owner) throw new Error(t('modelPresetLoginRequired'));
    return modelPresetPreferenceKey(owner);
  };
  const result = async <T>(operation: () => Promise<T>) => {
    try { return { success: true, data: await operation() }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  const resolveSelection = async (sessionId: string, presetId: ModelPresetId, requiresImage: boolean, initial: boolean) => {
    const isCurrent = dependencies.isAccountCurrent();
    const owner = dependencies.ownerAccountKey();
    if (!owner) throw new Error(t('modelPresetLoginRequired'));
    const revision = (selectionRevision.get(sessionId) ?? 0) + 1;
    selectionRevision.set(sessionId, revision);
    const session = getSessions().getSession(sessionId);
    if (!session || !isChatPresetSession(session)) throw new Error(t('modelPresetInvalidSession'));
    if (initial && session.modelPresetId === presetId && session.modelOverride) return session;
    if (!initial && (session.status === 'running' || dependencies.getRuntime().isSessionActive(sessionId))) throw new Error(t('modelPresetSessionBusy'));
    await dependencies.ensureModelsReady();
    if (!isCurrent()) throw new Error(t('modelPresetAccountChanged'));
    const model = await client.resolve(sessionId, presetId, requiresImage);
    if (!isCurrent()) throw new Error(t('modelPresetAccountChanged'));
    if (selectionRevision.get(sessionId) !== revision) throw new Error(t('modelPresetModelMismatch'));
    const modelRef = `${OpenClawProviderId.LobsteraiServer}/${model.modelId}`;
    const config = parseModelThinkingConfig(model.thinkingConfig);
    const thinkingLevel = config?.defaultLevel ?? '';
    if (!initial) {
      const patched = await dependencies.getRuntime().patchSession?.(sessionId, { model: modelRef, thinkingLevel: thinkingLevel || null });
      if (!patched || patched.modelOverride !== modelRef || patched.resolvedModelRef !== modelRef) throw new Error(t('modelPresetModelMismatch'));
    }
    if (!isCurrent()) throw new Error(t('modelPresetAccountChanged'));
    if (selectionRevision.get(sessionId) !== revision) throw new Error(t('modelPresetModelMismatch'));
    getSessions().updateSession(sessionId, { modelPresetId: presetId, modelOverride: modelRef, thinkingLevel }, { touchUpdatedAt: false });
    return getSessions().getSession(sessionId)!;
  };
  const choose = (sessionId: string, presetId: ModelPresetId, requiresImage: boolean, initial = false, thinkingLevel?: ModelThinkingLevel) => {
    const key = `${dependencies.ownerAccountKey()}:${sessionId}:${presetId}:${requiresImage}:${initial}:${thinkingLevel ?? ''}`;
    const existing = selections.get(key);
    if (existing) return existing;
    const selection = resolveSelection(sessionId, presetId, requiresImage, initial);
    selections.set(key, selection);
    void selection.finally(() => { if (selections.get(key) === selection) selections.delete(key); }).catch((): void => {});
    return selection;
  };
  ipcMain.handle(ModelPresetIpc.Available, () => result(() => client.available()));
  ipcMain.handle(ModelPresetIpc.GetPreferences, () => result(async () => {
    const saved = dependencies.getStore().get<Record<string, unknown>>(preferenceKey()) ?? {};
    return Object.fromEntries(Object.entries(saved).flatMap(([agentId, value]) => {
      const preference = parseModelPresetPreference(value);
      return preference ? [[agentId, preference]] : [];
    }));
  }));
  ipcMain.handle(ModelPresetIpc.SetPreference, (_event, agentId: unknown, rawPresetId: unknown, rawThinkingLevel: unknown) => result(async () => {
    if (typeof agentId !== 'string' || !agentId.trim()) throw new Error(t('modelPresetInvalidSession'));
    const presetId = parseModelPresetId(rawPresetId);
    const thinkingLevel = parseModelThinkingLevel(rawThinkingLevel);
    if (rawThinkingLevel !== undefined && !thinkingLevel) throw new Error(t('modelPresetInvalidSession'));
    if (rawPresetId !== null && !presetId) throw new Error(t('modelPresetInvalidSession'));
    if (!presetId && !dependencies.ownerAccountKey()) return null;
    const key = preferenceKey();
    const saved = { ...dependencies.getStore().get<Record<string, unknown>>(key) };
    if (presetId) saved[agentId] = { presetId, thinkingLevel };
    else delete saved[agentId];
    dependencies.getStore().set(key, saved);
    return presetId;
  }));
  ipcMain.handle(ModelPresetIpc.SelectSession, (_event, sessionId: unknown, rawPresetId: unknown, rawThinkingLevel: unknown) => result(async () => {
    const presetId = parseModelPresetId(rawPresetId);
    const thinkingLevel = parseModelThinkingLevel(rawThinkingLevel);
    if (rawThinkingLevel !== undefined && !thinkingLevel) throw new Error(t('modelPresetInvalidSession'));
    if (typeof sessionId !== 'string' || !presetId) throw new Error(t('modelPresetInvalidSession'));
    return choose(sessionId, presetId, false, false, thinkingLevel);
  }));
  return { choose };
}
