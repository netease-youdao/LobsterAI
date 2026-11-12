import { type IpcMain } from 'electron';

import { CoworkSessionStatusValue } from '../../shared/cowork/constants';
import { isChatPresetSession, type ModelPresetId, parseModelPresetId } from '../../shared/modelPresets/constants';
import {
  contextWindowPreferenceModelKey,
  ModelContextWindowIpc,
  type ModelContextWindowMetadata,
  type ModelContextWindowRequest,
  type ModelContextWindowState,
  selectableContextWindows,
  userContextWindowSelection,
} from '../../shared/providers/modelContextWindow';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkRuntime } from './agentEngine/types';
import { getServerModelMetadata } from './claudeSettings';
import { presetContextWindowSelection } from './modelPresetContext';

const PREFERENCE_KEY_PREFIX = 'model_context_windows:';

export const modelContextWindowOwnerKey = (owner: string, server: string): string => `${server}:${owner}`;

export function rememberedContextWindow(
  store: Pick<SqliteStore, 'get'>,
  ownerKey: string | null,
  modelId: string,
  presetId: ModelPresetId | undefined,
  options: readonly number[],
): number | null {
  if (!ownerKey) return null;
  const saved = store.get<Record<string, unknown>>(`${PREFERENCE_KEY_PREFIX}${ownerKey}`);
  const value = saved?.[contextWindowPreferenceModelKey(modelId, presetId)];
  return typeof value === 'number' && options.includes(value) ? value : null;
}

export function sessionContextWindowSelection(
  session: Pick<CoworkSession, 'contextWindowOverride' | 'contextWindowOwnerKey' | 'modelPresetId'>,
  model: ModelContextWindowMetadata | null,
  ownerKey: string | null,
): string | null {
  const presetId = session.modelPresetId ?? undefined;
  const override = session.contextWindowOwnerKey === ownerKey && ownerKey ? session.contextWindowOverride : null;
  return override && selectableContextWindows(model, presetId).includes(override)
    ? userContextWindowSelection(override, presetId)
    : presetContextWindowSelection(model, presetId);
}

export function registerModelContextWindowIpc(dependencies: {
  ipcMain: IpcMain;
  getStore: () => SqliteStore;
  getSessions: () => CoworkStore;
  getRuntime: () => CoworkRuntime;
  ownerKey: () => string | null;
  resolveSessionModel?: (session: CoworkSession) => string;
  ensureModelsReady: () => Promise<unknown>;
  t: (key: string) => string;
}) {
  const { getStore, getSessions, getRuntime, ownerKey, t } = dependencies;
  const modelIdForSession = (session: CoworkSession): string => {
    const modelRef = dependencies.resolveSessionModel?.(session) || session.modelOverride;
    return modelRef.slice(modelRef.indexOf('/') + 1);
  };
  const resolveRequest = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(t('modelContextWindowUnavailable'));
    const request = input as ModelContextWindowRequest;
    const presetId = parseModelPresetId(request.presetId) ?? undefined;
    if (typeof request.modelId !== 'string' || !request.modelId.trim()
      || (request.presetId !== undefined && !presetId)
      || (request.sessionId !== undefined && typeof request.sessionId !== 'string')) {
      throw new Error(t('modelContextWindowUnavailable'));
    }
    const session = request.sessionId ? getSessions().getSession(request.sessionId) : null;
    if (request.sessionId && (!session || !isChatPresetSession(session))) throw new Error(t('modelContextWindowUnavailable'));
    const sameModel = session && contextWindowPreferenceModelKey(modelIdForSession(session), session.modelPresetId ?? undefined)
      === contextWindowPreferenceModelKey(request.modelId, presetId);
    const model = getServerModelMetadata(sameModel ? modelIdForSession(session) : request.modelId);
    return { request, presetId, session: sameModel ? session : null, model };
  };
  const get = (input: unknown): ModelContextWindowState => {
    const { request, presetId, session, model } = resolveRequest(input);
    const options = selectableContextWindows(model, presetId);
    const override = session
      ? !!ownerKey() && session.contextWindowOwnerKey === ownerKey() && options.includes(session.contextWindowOverride ?? 0)
        ? session.contextWindowOverride ?? null : null
      : rememberedContextWindow(getStore(), ownerKey(), request.modelId, presetId, options);
    return {
      options,
      defaultWindow: presetId ? model?.presetContextWindows?.[presetId] ?? undefined : model?.contextWindow,
      override,
    };
  };
  const restoreForSession = (sessionId: string) => {
    const session = getSessions().getSession(sessionId);
    if (!session || !isChatPresetSession(session)) return;
    const modelId = modelIdForSession(session);
    const override = rememberedContextWindow(getStore(), ownerKey(), modelId, session.modelPresetId ?? undefined,
      selectableContextWindows(getServerModelMetadata(modelId), session.modelPresetId ?? undefined));
    getSessions().updateSession(sessionId, { contextWindowOverride: override, contextWindowOwnerKey: override ? ownerKey() : null }, { touchUpdatedAt: false });
  };
  const result = async (operation: () => Promise<ModelContextWindowState>) => {
    try { return { success: true, data: await operation() }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  dependencies.ipcMain.handle(ModelContextWindowIpc.Get, (_event, input: unknown) => result(async () => get(input)));
  dependencies.ipcMain.handle(ModelContextWindowIpc.Set, (_event, input: unknown, tokens: unknown) => result(async () => {
    const owner = ownerKey();
    if (!owner) throw new Error(t('modelPresetLoginRequired'));
    await dependencies.ensureModelsReady();
    if (owner !== ownerKey()) throw new Error(t('authAccountChanged'));
    const { request, presetId, session, model } = resolveRequest(input);
    if (request.sessionId && !session) throw new Error(t('modelContextWindowUnavailable'));
    if (tokens !== null && (typeof tokens !== 'number' || !selectableContextWindows(model, presetId).includes(tokens))) {
      throw new Error(t('modelContextWindowUnavailable'));
    }
    if (session) {
      if (session.status === CoworkSessionStatusValue.Running || getRuntime().isSessionActive(session.id)) throw new Error(t('modelPresetSessionBusy'));
      const runtime = getRuntime();
      if (!runtime.patchSession) throw new Error(t('modelContextWindowUnavailable'));
      await runtime.patchSession(session.id, {
        contextWindow: tokens === null ? presetContextWindowSelection(model, presetId) : userContextWindowSelection(tokens as number, presetId),
      });
      if (owner !== ownerKey()) throw new Error(t('authAccountChanged'));
      const latest = getSessions().getSession(session.id);
      if (latest?.modelOverride !== session.modelOverride || latest.modelPresetId !== session.modelPresetId) throw new Error(t('modelContextWindowUnavailable'));
      getSessions().updateSession(session.id, { contextWindowOverride: tokens as number | null, contextWindowOwnerKey: tokens ? owner : null }, { touchUpdatedAt: false });
    }
    const key = `${PREFERENCE_KEY_PREFIX}${owner}`;
    const saved = { ...getStore().get<Record<string, number>>(key) };
    const modelKey = contextWindowPreferenceModelKey(request.modelId, presetId);
    if (tokens === null) delete saved[modelKey];
    else saved[modelKey] = tokens as number;
    if (Object.keys(saved).length) getStore().set(key, saved);
    else getStore().delete(key);
    console.debug(`[ModelContextWindow] user selected ${tokens ?? 'default'} for ${modelKey}; session=${request.sessionId ?? 'new'}`);
    return get(request);
  }));
  return { restoreForSession };
}
