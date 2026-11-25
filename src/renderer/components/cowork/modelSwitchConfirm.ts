import { CoworkSystemMessageKind } from '../../../common/coworkSystemMessages';
import type { CoworkModelChange } from '../../../shared/cowork/modelChange';
import {
  type ModelPresetId,
  modelPresetModelId,
  parseModelPresetModelId,
} from '../../../shared/modelPresets/constants';
import { modelPresetName } from '../../services/modelPresets';
import type { Model } from '../../store/slices/modelSlice';
import type { CoworkSession } from '../../types/cowork';
import { matchesOpenClawModelRef, toOpenClawModelRef } from '../../utils/openclawModelRef';

export const MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY = 'lobsterai.skip-model-switch-confirm';
const SKIP_CONFIRM_VALUE = '1';

export interface ModelSwitchConfirmInfo {
  previousModelName: string;
  nextModelName: string;
}

export interface ResolveModelSwitchConfirmInput {
  session: CoworkSession | null | undefined;
  availableModels: readonly Model[];
  currentEffectiveModel: Model | null;
  nextModel: Model;
  sessionModelIsInvalid: boolean;
  thinkingOnly?: boolean;
  skipConfirm?: boolean;
}

interface ModelSelectionIdentity {
  modelRef: string;
  presetId: ModelPresetId | null;
}

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function isModelSwitchConfirmSkipped(): boolean {
  try {
    return getStorage()?.getItem(MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY) === SKIP_CONFIRM_VALUE;
  } catch {
    return false;
  }
}

export function setModelSwitchConfirmSkipped(skipped: boolean): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    if (skipped) {
      storage.setItem(MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY, SKIP_CONFIRM_VALUE);
    } else {
      storage.removeItem(MODEL_SWITCH_CONFIRM_SKIP_STORAGE_KEY);
    }
  } catch {
    // Best-effort preference persistence; switching still proceeds.
  }
}

export function resolveModelChangeDisplayName(
  modelRef: string,
  models: readonly Model[],
  presetId?: ModelPresetId | null,
): string {
  // Older notices stored an agent-default preset as its bare model id.
  const resolvedPresetId = presetId ?? parseModelPresetModelId(modelRef);
  if (resolvedPresetId) return modelPresetName(resolvedPresetId);
  const model = models.find(candidate => !candidate.presetId && matchesOpenClawModelRef(modelRef, candidate));
  return model?.name ?? (modelRef.includes('/') ? modelRef.slice(modelRef.indexOf('/') + 1) : modelRef);
}

function isSameSelection(a: ModelSelectionIdentity, b: ModelSelectionIdentity): boolean {
  if (a.presetId || b.presetId) {
    return a.presetId === b.presetId;
  }
  if (a.modelRef === b.modelRef) return true;
  const bareA = a.modelRef.split('/').slice(-1)[0];
  const bareB = b.modelRef.split('/').slice(-1)[0];
  return (!a.modelRef.includes('/') || !b.modelRef.includes('/')) && bareA === bareB;
}

function resolveCurrentSelection(
  session: CoworkSession,
  currentEffectiveModel: Model | null,
): ModelSelectionIdentity | null {
  const explicitOverride = session.modelOverride.trim();
  if (session.modelPresetId) {
    return {
      modelRef: explicitOverride || modelPresetModelId(session.modelPresetId),
      presetId: session.modelPresetId,
    };
  }
  if (explicitOverride) {
    return {
      modelRef: explicitOverride,
      presetId: parseModelPresetModelId(explicitOverride),
    };
  }
  if (currentEffectiveModel) {
    return {
      modelRef: currentEffectiveModel.presetId
        ? currentEffectiveModel.id
        : toOpenClawModelRef(currentEffectiveModel),
      presetId: currentEffectiveModel.presetId ?? null,
    };
  }
  return null;
}

function findTrailingPendingModelChange(session: CoworkSession): CoworkModelChange | null {
  let pendingChange: CoworkModelChange | null = null;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    const change = message.metadata?.modelChange;
    if (
      message.type !== 'system'
      || message.metadata?.kind !== CoworkSystemMessageKind.ModelChanged
      || !change
    ) {
      break;
    }
    pendingChange = change;
  }
  return pendingChange;
}

/**
 * Decide whether switching the active session's model should prompt the user
 * before invalidating the cached conversation context.
 */
export function resolveModelSwitchConfirmation({
  session,
  availableModels,
  currentEffectiveModel,
  nextModel,
  sessionModelIsInvalid,
  thinkingOnly = false,
  skipConfirm = isModelSwitchConfirmSkipped(),
}: ResolveModelSwitchConfirmInput): ModelSwitchConfirmInfo | null {
  if (skipConfirm || !session || sessionModelIsInvalid || thinkingOnly) {
    return null;
  }

  const hasConversationHistory = (session.messagesOffset ?? 0) > 0
    || session.messages.some(message => message.type === 'user');
  if (!hasConversationHistory) {
    return null;
  }

  const currentSelection = resolveCurrentSelection(session, currentEffectiveModel);
  const nextSelection: ModelSelectionIdentity = {
    modelRef: nextModel.presetId ? nextModel.id : toOpenClawModelRef(nextModel),
    presetId: nextModel.presetId ?? null,
  };
  if (!currentSelection || isSameSelection(currentSelection, nextSelection)) {
    return null;
  }

  const pendingChange = findTrailingPendingModelChange(session);
  const cachedSelection: ModelSelectionIdentity = pendingChange
    ? {
      modelRef: pendingChange.previousModelRef,
      presetId: pendingChange.previousPresetId ?? parseModelPresetModelId(pendingChange.previousModelRef),
    }
    : currentSelection;

  // Switching back to the model this conversation is already cached for
  // cancels any pending switch without invalidating prompt cache.
  if (isSameSelection(cachedSelection, nextSelection)) {
    return null;
  }

  const previousModelName = resolveModelChangeDisplayName(
    cachedSelection.modelRef,
    availableModels,
    cachedSelection.presetId,
  );
  const nextModelName = nextModel.presetId
    ? modelPresetName(nextModel.presetId)
    : (nextModel.name || resolveModelChangeDisplayName(nextSelection.modelRef, availableModels, null));

  if (!previousModelName || !nextModelName) {
    return null;
  }

  return { previousModelName, nextModelName };
}
