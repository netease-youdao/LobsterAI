import { UsageAnalytics, UsageStage } from '../../shared/analytics/usage';
import {
  type MediaPreference,
  MediaPreferenceMode,
  type MediaPreferenceResult,
  type MediaSelection,
  MediaSelectionSource,
  MediaType,
} from '../../shared/media/defaultPolicy';
import { canonicalizeMediaModelId } from '../../shared/mediaModelAliases';
import { type AppDispatch, store } from '../store';
import { setMediaSelection } from '../store/slices/coworkSlice';
import { LogReporterAction, reportYdAnalyzer } from './logReporter';
import { getDraftAnalytics, getSessionUsageContext } from './usageAnalytics';

export interface MediaSelectionScope {
  draftKey: string;
  ownerAccountKey: string;
  accountGeneration: number;
}

const pendingVersions = new Map<string, number>();
export const isMediaAccountScopeCurrent = (owner: string, generation: number): boolean => {
  const auth = store.getState().auth;
  return auth.ownerAccountKey === owner && auth.accountGeneration === generation;
};

async function applyRequest(
  dispatch: AppDispatch, scope: MediaSelectionScope, request: () => Promise<MediaPreferenceResult>,
): Promise<boolean> {
  const key = `${scope.ownerAccountKey}:${scope.accountGeneration}:${scope.draftKey}`;
  const version = (pendingVersions.get(key) ?? 0) + 1;
  pendingVersions.set(key, version);
  try {
    const result = await request();
    if (!isMediaAccountScopeCurrent(scope.ownerAccountKey, scope.accountGeneration)
      || pendingVersions.get(key) !== version) return false;
    if (!result.success || !result.state || result.state.ownerAccountKey !== scope.ownerAccountKey) {
      throw new Error(result.error || 'Media preferences unavailable');
    }
    const current = store.getState().cowork.mediaSelection[scope.draftKey];
    if ((current?.preferencesRevision ?? -1) > result.state.preferences.revision) return false;
    const next = result.state.selection;
    dispatch(setMediaSelection({ draftKey: scope.draftKey, selection: next }));
    if ((next.imageSource === MediaSelectionSource.Default || next.videoSource === MediaSelectionSource.Default)
      && (current?.policyVersion !== next.policyVersion || current?.imageSource !== next.imageSource
        || current?.videoSource !== next.videoSource)) {
      void reportYdAnalyzer({ action: LogReporterAction.MediaLifecycle, schemaVersion: UsageAnalytics.SchemaVersion,
        ...getDraftAnalytics(store.getState().agent.currentAgentId), ...getSessionUsageContext(scope.draftKey),
        stage: UsageStage.View, entry: 'default_policy', policyVersion: next.policyVersion,
        imageSource: next.imageSource, videoSource: next.videoSource });
    }
    return true;
  } catch (error) {
    console.warn('[MediaPreferences] Could not apply media preference.', error);
    return false;
  }
}

export const refreshMediaPreferences = (dispatch: AppDispatch, scope: MediaSelectionScope): Promise<boolean> => (
  applyRequest(dispatch, scope, () => window.electron.media.getPreferences(scope.ownerAccountKey))
);

export const setMediaPreference = (
  dispatch: AppDispatch, scope: MediaSelectionScope, type: MediaType, preference: MediaPreference,
): Promise<boolean> => (
  applyRequest(dispatch, scope, () => window.electron.media.setPreference(scope.ownerAccountKey, type, preference))
);

export function toggleMediaModelSelection(
  dispatch: AppDispatch, scope: MediaSelectionScope, selection: MediaSelection | undefined,
  type: MediaType, model: { modelId: string; displayName: string },
): Promise<boolean> {
  const current = type === MediaType.Image
    ? selection?.imageModelId ?? (selection?.mode === MediaType.Image ? selection.modelId : undefined)
    : selection?.videoModelId ?? (selection?.mode === MediaType.Video ? selection.modelId : undefined);
  const preference: MediaPreference = canonicalizeMediaModelId(current) === canonicalizeMediaModelId(model.modelId)
    ? { mode: MediaPreferenceMode.Off }
    : { mode: MediaPreferenceMode.Selected, modelId: model.modelId, modelName: model.displayName };
  return setMediaPreference(dispatch, scope, type, preference);
}
